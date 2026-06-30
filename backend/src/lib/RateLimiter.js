'use strict';
/**
 * RateLimiter.js — Per-Route Rate Limiting
 * Phase 5 — FIX-15: Rate Limiting per Route
 * FIX-IPv6: استخدام ipKeyGenerator لتفادي خطأ ERR_ERL_KEY_GEN_IPV6
 *
 * [البند 5 — نقل العدادات إلى Redis] إصلاح: express-rate-limit بدون store
 * مخصص يستخدم In-Memory Store افتراضياً، مما يعني أن الحدود (مثل 5 محاولات
 * تسجيل دخول/دقيقة) تُحسَب بشكل منفصل لكل Node process. في أي بيئة
 * Multi-Instance (Horizontal Scaling) هذا يضاعف الحد الفعلي بعدد الـ
 * instances فعلياً (ثغرة brute-force bypass)، وتُصفَّر العدادات بالكامل عند
 * أي إعادة تشغيل. تم استبداله بـ RedisRateLimitStore مخصص يعتمد على نفس
 * اتصال Redis المركزي (RedisManager.getRateLimit())، بعمليات ذرية
 * (INCR + EXPIRE فقط عند أول طلب) متّسقة مع نمط RedisCounters في
 * ProtectionService.js.
 */
const rateLimit = require('express-rate-limit');
const RedisManager = require('./RedisManager');

const STORE_PREFIX = 'http-rl:';

// ── Redis Store مخصص متوافق مع واجهة express-rate-limit v8 ─────────────────
// (init / increment / decrement / resetKey) — Atomic عبر INCR + EXPIRE،
// بنفس فلسفة RedisCounters.incrWithExpire في ProtectionService.js.
class RedisRateLimitStore {
    // [إصلاح حرج] كل limiter يجب أن يملك namespace خاص في Redis — بدون هذا،
    // طلب من نفس IP يُحسب في limiter "تسجيل الدخول" وlimiter "تجديد التوكن"
    // كمفتاح واحد مشترك (تصادم Race Condition منطقي)، فيُسقِط أحدهما الآخر
    // خطأً عند الوصول للحد. الاسم يُمرَّر صراحة عند الإنشاء لكل limiter.
    constructor(namespace) {
        this.windowMs  = 60 * 1000; // يُستبدل فعلياً في init() حسب كل limiter
        this.namespace = namespace || 'default';
    }

    init(options) {
        // يُستدعى تلقائياً من express-rate-limit مع إعدادات الـ limiter
        this.windowMs = options.windowMs;
    }

    _redis() {
        return RedisManager.getRateLimit();
    }

    _key(key) {
        return `${STORE_PREFIX}${this.namespace}:${key}`;
    }

    async increment(key) {
        const redisKey = this._key(key);
        try {
            const redis = this._redis();
            const ttlSeconds = Math.max(1, Math.ceil(this.windowMs / 1000));
            // عملية ذرية: INCR ثم EXPIRE فقط عند أول طلب (value === 1) لتفادي
            // إعادة تعيين النافذة الزمنية في كل طلب لاحق (سلوك "fixed window" صحيح)
            const totalHits = await redis.incr(redisKey);
            if (totalHits === 1) {
                await redis.expire(redisKey, ttlSeconds);
            }
            const ttl = await redis.ttl(redisKey);
            const resetTime = new Date(Date.now() + Math.max(0, ttl) * 1000);
            return { totalHits, resetTime };
        } catch (err) {
            // فشل Redis لا يجب أن يُسقط الـ API بالكامل — نسمح بالطلب مع تسجيل
            // الخطأ، تماماً كفلسفة RedisCounters.incrWithExpire (Fail-Open آمن
            // لمسار الحماية الثانوي هذا، وليس فشلاً صامتاً لمسار حساس أمنياً
            // كالمصادقة نفسها — المصادقة تبقى محمية بطبقات أخرى).
            console.error(`[RateLimiter/Redis] increment(${key}) error:`, err.message);
            return { totalHits: 0, resetTime: new Date(Date.now() + this.windowMs) };
        }
    }

    async decrement(key) {
        try {
            const redis = this._redis();
            const redisKey = this._key(key);
            const val = await redis.decr(redisKey);
            if (val < 0) await redis.set(redisKey, 0);
        } catch (err) {
            console.error(`[RateLimiter/Redis] decrement(${key}) error:`, err.message);
        }
    }

    async resetKey(key) {
        try {
            await this._redis().del(this._key(key));
        } catch (err) {
            console.error(`[RateLimiter/Redis] resetKey(${key}) error:`, err.message);
        }
    }
}

// ── Key Generator: IP + User ID ────────────────────────────────────────────
// express-rate-limit v7+ يشترط استخدام ipKeyGenerator عند بناء مفتاح من req.ip
function keyGenerator(req) {
    // استخدم الدالة المدمجة لاستخراج IP بشكل آمن (تدعم IPv4 و IPv6)
    const ip = rateLimit.ipKeyGenerator(req);
    const userId = req.user?.id;
    return userId ? `${ip}:${userId}` : ip;
}

function makeLimit({ windowMs, max, message, namespace }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders:   false,
        keyGenerator,
        message: { success: false, error: message },
        skip: (req) => process.env.DISABLE_RATE_LIMIT === 'true',
        // [البند 5] Redis-backed store بدل In-Memory الافتراضي — متّسق عبر كل
        // النسخ (Multi-Instance) وينجو من إعادة التشغيل. namespace منفصل لكل
        // limiter يمنع تصادم المفاتيح بين limiters مختلفة لنفس IP/userId.
        store: new RedisRateLimitStore(namespace),
    });
}

// ── Auth Limiters ──────────────────────────────────────────────────────────

const loginLimiter = makeLimit({
    namespace: 'login',
    windowMs: 60 * 1000,
    max: 5,
    message: 'عدد كبير من محاولات تسجيل الدخول. حاول بعد دقيقة.'
});

const refreshLimiter = makeLimit({
    namespace: 'refresh',
    windowMs: 60 * 1000,
    max: 10,
    message: 'عدد كبير من طلبات تجديد التوكن. حاول بعد دقيقة.'
});

const globalAuthLimiter = makeLimit({
    namespace: 'global-auth',
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'عدد كبير من المحاولات على مسارات المصادقة، حاول بعد 15 دقيقة.'
});

// ── API Limiters ───────────────────────────────────────────────────────────

const listAccountsLimiter = makeLimit({
    namespace: 'list-accounts',
    windowMs: 60 * 1000,
    max: 60,
    message: 'عدد كبير من طلبات قائمة الحسابات. حاول بعد دقيقة.'
});

const sendMessageLimiter = makeLimit({
    namespace: 'send-message',
    windowMs: 60 * 1000,
    max: 100,
    message: 'تجاوزت حد إرسال الرسائل. حاول بعد دقيقة.'
});

const adminLimiter = makeLimit({
    namespace: 'admin',
    windowMs: 60 * 1000,
    max: 30,
    message: 'عدد كبير من طلبات الإدارة. حاول بعد دقيقة.'
});

const globalApiLimiter = makeLimit({
    namespace: 'global-api',
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'تجاوزت الحد العام للطلبات. حاول بعد 15 دقيقة.'
});

const campaignSendLimiter = makeLimit({
    namespace: 'campaign-send',
    windowMs: 60 * 1000,
    max: 20,
    message: 'تجاوزت حد بدء الحملات. حاول بعد دقيقة.'
});

module.exports = {
    loginLimiter,
    refreshLimiter,
    globalAuthLimiter,
    listAccountsLimiter,
    sendMessageLimiter,
    adminLimiter,
    globalApiLimiter,
    campaignSendLimiter,
};
