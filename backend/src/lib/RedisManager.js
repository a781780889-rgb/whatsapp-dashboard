'use strict';
/**
 * RedisManager — [FIX-18] Dedicated Redis Connections
 *
 * المشكلة قبل الإصلاح:
 *   - اتصال Redis واحد يُستخدم لكل شيء: Cache + Pub/Sub + Rate Limiting + Socket.IO
 *   - أي عملية بطيئة (مثل SUBSCRIBE blocking) تُوقف باقي الاتصالات
 *   - Redis Pub/Sub يتطلب اتصالاً حصرياً لا يقبل أوامر أخرى بعد SUBSCRIBE
 *
 * الحل — 4 اتصالات منفصلة:
 *   ┌─────────────┬──────────────────────────────────────────────────────────┐
 *   │ cache       │ SET/GET/DEL/EXPIRE — الاستخدام العام                    │
 *   │ pub         │ PUBLISH — Socket.IO adapter + EventBus cross-process     │
 *   │ sub         │ SUBSCRIBE — Socket.IO adapter + EventBus cross-process   │
 *   │ rateLimit   │ INCR/EXPIRE — عمليات Rate Limiting المتكررة             │
 *   └─────────────┴──────────────────────────────────────────────────────────┘
 *
 * BullMQ يحتاج اتصالاته الخاصة — تبقى عبر getBullMQConnection() في redis.js
 */

const Redis = require('ioredis');

/**
 * مصنع الاتصالات — يُنشئ كل اتصال بإعدادات مُحسَّنة لاستخدامه المحدد
 * @param {string} name  - اسم الاتصال (للـ logging)
 * @param {object} extra - إعدادات إضافية تُدمج فوق الإعدادات الافتراضية
 */
function createConnection(name, extra = {}) {
    const url = process.env.REDIS_URL;
    if (!url) {
        throw new Error(
            `[RedisManager] REDIS_URL is required. ` +
            `Add it to your environment variables (Upstash free tier recommended for Railway).`
        );
    }

    const conn = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        connectTimeout: 10_000,
        retryStrategy: (times) => {
            const delay = Math.min(times * 150, 5_000);
            console.log(`[Redis:${name}] Reconnecting attempt ${times} — delay ${delay}ms`);
            return delay;
        },
        lazyConnect: false,
        ...extra,
    });

    conn.on('connect',      () => console.log(`[Redis:${name}] Connected.`));
    conn.on('ready',        () => console.log(`[Redis:${name}] Ready.`));
    conn.on('error',        (err) => console.error(`[Redis:${name}] Error: ${err.message}`));
    conn.on('close',        () => console.warn(`[Redis:${name}] Connection closed.`));
    conn.on('reconnecting', () => console.log(`[Redis:${name}] Reconnecting...`));

    return conn;
}

// ── Singleton instances ───────────────────────────────────────────────────────
let _cache     = null;   // GET/SET/DEL/EXPIRE
let _pub       = null;   // PUBLISH فقط
let _sub       = null;   // SUBSCRIBE فقط (blocking mode)
let _rateLimit = null;   // INCR/EXPIRE للـ Rate Limiting

const RedisManager = {
    /**
     * اتصال Cache العام — مناسب لـ SessionPersistence + JWT blacklist + بيانات مؤقتة
     */
    getCache() {
        if (_cache && _cache.status !== 'end') return _cache;
        _cache = createConnection('cache');
        return _cache;
    },

    /**
     * اتصال Publisher — لـ Socket.IO Redis Adapter + EventBus cross-process
     * يُستخدم فقط للـ PUBLISH ولا يُستدعى مع SUBSCRIBE أبداً
     */
    getPub() {
        if (_pub && _pub.status !== 'end') return _pub;
        _pub = createConnection('pub', {
            // Publisher لا يحتاج ready check لأنه يُرسل فقط
            enableReadyCheck: false,
        });
        return _pub;
    },

    /**
     * اتصال Subscriber — مُخصص للـ SUBSCRIBE/PSUBSCRIBE حصراً
     * Redis يمنع إرسال أوامر أخرى عبر نفس الاتصال بعد SUBSCRIBE
     */
    getSub() {
        if (_sub && _sub.status !== 'end') return _sub;
        _sub = createConnection('sub', {
            enableReadyCheck: false,
            // subscriber mode — لا يُعيد الاتصال تلقائياً لأن ioredis يديره
        });
        return _sub;
    },

    /**
     * اتصال Rate Limiting — مُحسَّن للعمليات الكثيرة قصيرة الأمد
     */
    getRateLimit() {
        if (_rateLimit && _rateLimit.status !== 'end') return _rateLimit;
        _rateLimit = createConnection('ratelimit', {
            maxRetriesPerRequest: 1,  // فشل سريع — Rate Limiting لا يستحق الانتظار
        });
        return _rateLimit;
    },

    /**
     * إغلاق جميع الاتصالات بشكل آمن عند إيقاف التطبيق
     */
    async closeAll() {
        const connections = [
            { name: 'cache',     conn: _cache },
            { name: 'pub',       conn: _pub },
            { name: 'sub',       conn: _sub },
            { name: 'rateLimit', conn: _rateLimit },
        ];

        for (const { name, conn } of connections) {
            if (conn && conn.status !== 'end') {
                try {
                    await conn.quit();
                    console.log(`[RedisManager] ${name} connection closed.`);
                } catch (err) {
                    conn.disconnect();
                    console.warn(`[RedisManager] ${name} force-disconnected: ${err.message}`);
                }
            }
        }

        _cache     = null;
        _pub       = null;
        _sub       = null;
        _rateLimit = null;
    },

    /**
     * فحص صحة جميع الاتصالات — يُستخدم في /health endpoint
     */
    async healthCheck() {
        const results = {};
        const checks = [
            { name: 'cache',     getConn: () => this.getCache() },
            { name: 'pub',       getConn: () => this.getPub() },
            { name: 'rateLimit', getConn: () => this.getRateLimit() },
        ];

        for (const { name, getConn } of checks) {
            try {
                const start = Date.now();
                await getConn().ping();
                results[name] = { status: 'ok', latencyMs: Date.now() - start };
            } catch (err) {
                results[name] = { status: 'error', error: err.message };
            }
        }

        // subscriber لا يقبل PING في subscriber mode
        results.sub = {
            status: _sub && _sub.status === 'ready' ? 'ok' : 'disconnected',
        };

        return results;
    },
};

module.exports = RedisManager;
