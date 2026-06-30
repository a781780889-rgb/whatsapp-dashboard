'use strict';
/**
 * ProtectionService — نظام الحماية المتقدم (إعادة هيكلة كاملة)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * التعديلات الجوهرية عن النسخة السابقة:
 *
 *  1) Redis بدل الذاكرة:
 *     جميع العدادات (Hourly/Daily limits, Retry counters, Error counters,
 *     Suspended accounts, Task distribution load) أصبحت في Redis عبر
 *     RedisManager.getCache()، باستخدام INCR/EXPIRE الذرية. هذا يحل مشكلتين:
 *       - فقدان العدادات عند كل إعادة تشغيل/نشر (كانت تمنح الحساب "صفحة بيضاء"
 *         فوراً بعد التشغيل، وهي ثغرة حظر حقيقية).
 *       - عدم اتساق العدادات إذا عمل أكثر من Node.js instance في نفس الوقت
 *         (Railway قد يُشغّل أكثر من نسخة خلف Load Balancer).
 *
 *  2) عزل متعدد المستأجرين (Multi-Tenant):
 *     لا يوجد أي Map/Set مشترك بين المستخدمين بعد الآن. كل بنية حالة
 *     (Limiter, Monitor, Retryer, Distributor) مفهرسة صراحة بـ userId،
 *     وكل مفتاح Redis مسبوق بـ protection:{userId}:...
 *
 *  3) فصل حدود المجموعات عن حدود الرسائل الخاصة:
 *     operation_type ('group' | 'private') يحدد أي عداد/حد يُستخدم.
 *     كل من Hourly / Daily / Delay / Warmup / Retry / Error Threshold
 *     أصبح له نسخة مستقلة لكل نوع.
 *
 *  4) Warm-up تلقائي للحسابات الجديدة:
 *     بناءً على عمر الحساب (accountCreatedAt) تُخفَّض الحدود تلقائياً:
 *       يوم 1-2:  20% من الحد الأقصى
 *       يوم 3-7:  50% من الحد الأقصى
 *       بعد ذلك: 100%
 *
 *  5) تصنيف الأخطاء:
 *     classifyError() يُصنّف كل خطأ إلى:
 *       temporary | network | timeout | rate_limit | forbidden | banned |
 *       invalid
 *     وفقط الأخطاء القابلة لإعادة المحاولة (temporary/network/timeout)
 *     تُمرَّر إلى SmartRetry. أخطاء forbidden/banned توقف الحساب فوراً
 *     عبر suspendAccount() دون انتظار وصول عداد الأخطاء لحدّه.
 *
 * التوافق العكسي:
 *   جميع الدوال العامة المستخدمة سابقاً (loadConfig, saveConfig, checkOperation,
 *   recordSuccess, recordFailure, suspendAccount, resumeAccount, safeDelay,
 *   pickAccount, getStats, cleanOldLogs, getInstance) بقيت بنفس الاسم وبنفس
 *   عدد/ترتيب المعاملات الإلزامية. أي معامل جديد (operationType,
 *   accountCreatedAt) أُضيف كـ optional بقيمة افتراضية آمنة، حتى لا تنكسر
 *   أي استدعاءات قديمة (مثل ProtectionController الحالي).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { getPool } = require('../../lib/postgres');
const RedisManager = require('../../lib/RedisManager');
const crypto = require('crypto');

// ─── ثوابت ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    // حدود عامة (تُستخدم كـ fallback إن لم تُحدَّد حدود group/private منفصلة)
    max_ops_per_hour:       20,
    max_ops_per_day:       100,
    min_delay_between_ops:  30,   // ثانية
    max_delay_between_ops: 120,   // ثانية

    // [البند 6] حدود مستقلة للمجموعات
    group_max_ops_per_hour:       20,
    group_max_ops_per_day:       100,
    group_min_delay_between_ops:  30,
    group_max_delay_between_ops: 120,

    // [البند 6] حدود مستقلة للرسائل الخاصة
    private_max_ops_per_hour:       15,
    private_max_ops_per_day:        80,
    private_min_delay_between_ops:  20,
    private_max_delay_between_ops:  90,

    distribution_mode:     'round_robin',  // round_robin | weighted | priority | least_busy
    error_threshold:         5,   // أخطاء متتالية قابلة لإعادة المحاولة قبل إيقاف الحساب
    auto_disable_on_error: true,
    retry_enabled:         true,
    max_retries:             3,
    retry_base_delay:       60,   // ثانية (يتضاعف مع كل محاولة)
    retry_max_delay:      1800,   // 30 دقيقة
    log_retention_days:     30,

    // [البند 7] إعدادات Warm-up
    warmup_enabled:             true,
    warmup_stage1_days:         2,     // أيام 1-2 → 20%
    warmup_stage1_ratio:        0.20,
    warmup_stage2_days:         7,     // أيام 3-7 → 50%
    warmup_stage2_ratio:        0.50,
    warmup_full_ratio:          1.0,

    is_active: true,
};

const REDIS_PREFIX = 'protection';
const SEC_PER_HOUR  = 3600;
const SEC_PER_DAY   = 86400;

// ════════════════════════════════════════════════════════════════════════════
//  أدوات Redis مساعدة — عمليات ذرية على العدادات
// ════════════════════════════════════════════════════════════════════════════
const RedisCounters = {
    _redis() {
        return RedisManager.getCache();
    },

    /**
     * زيادة عداد بمفتاح محدد مع ضبط TTL إذا كان هذا أول استدعاء (مفتاح جديد)
     * يستخدم INCR (ذري) ثم EXPIRE فقط عند value === 1 لتفادي إعادة تعيين TTL
     * في كل عملية (وهو ما كان سيمنع انتهاء الصلاحية أبداً تحت ضغط مستمر).
     */
    async incrWithExpire(key, ttlSeconds) {
        try {
            const redis = this._redis();
            const value = await redis.incr(key);
            if (value === 1) {
                await redis.expire(key, ttlSeconds);
            }
            return value;
        } catch (err) {
            console.error(`[ProtectionService/Redis] incrWithExpire(${key}) error:`, err.message);
            // فشل Redis لا يجب أن يوقف الإرسال بالكامل — نُرجع 0 (نسمح بالعملية)
            // مع تسجيل الخطأ، حتى لا يتحول عطل بنية تحتية إلى توقف كامل للخدمة.
            return 0;
        }
    },

    async get(key) {
        try {
            const v = await this._redis().get(key);
            return v === null ? null : parseInt(v, 10);
        } catch (err) {
            console.error(`[ProtectionService/Redis] get(${key}) error:`, err.message);
            return null;
        }
    },

    async ttl(key) {
        try {
            const t = await this._redis().ttl(key);
            return t > 0 ? t : 0;
        } catch {
            return 0;
        }
    },

    async set(key, value, ttlSeconds = null) {
        try {
            if (ttlSeconds) await this._redis().set(key, value, 'EX', ttlSeconds);
            else await this._redis().set(key, value);
        } catch (err) {
            console.error(`[ProtectionService/Redis] set(${key}) error:`, err.message);
        }
    },

    async del(key) {
        try { await this._redis().del(key); } catch (err) {
            console.error(`[ProtectionService/Redis] del(${key}) error:`, err.message);
        }
    },

    async sadd(key, member) {
        try { await this._redis().sadd(key, member); } catch (err) {
            console.error(`[ProtectionService/Redis] sadd(${key}) error:`, err.message);
        }
    },

    async srem(key, member) {
        try { await this._redis().srem(key, member); } catch (err) {
            console.error(`[ProtectionService/Redis] srem(${key}) error:`, err.message);
        }
    },

    async sismember(key, member) {
        try {
            const r = await this._redis().sismember(key, member);
            return r === 1;
        } catch (err) {
            console.error(`[ProtectionService/Redis] sismember(${key}) error:`, err.message);
            return false;
        }
    },

    async smembers(key) {
        try { return await this._redis().smembers(key); } catch { return []; }
    },
};

// ════════════════════════════════════════════════════════════════════════════
//  1. RateLimiter — تحديد سرعة العمليات (Redis-backed، مفصول حسب operationType)
// ════════════════════════════════════════════════════════════════════════════
class RateLimiter {
    constructor(userId, cfg) {
        this.userId = userId;
        this.cfg    = cfg;
    }

    _limits(operationType) {
        if (operationType === 'private') {
            return {
                hour: this.cfg.private_max_ops_per_hour ?? this.cfg.max_ops_per_hour,
                day:  this.cfg.private_max_ops_per_day  ?? this.cfg.max_ops_per_day,
            };
        }
        // 'group' أو أي قيمة أخرى → حدود المجموعات (الافتراضي السابق)
        return {
            hour: this.cfg.group_max_ops_per_hour ?? this.cfg.max_ops_per_hour,
            day:  this.cfg.group_max_ops_per_day  ?? this.cfg.max_ops_per_day,
        };
    }

    _keys(accountId, operationType) {
        const now  = Date.now();
        const hourBucket = Math.floor(now / 3_600_000);
        const dayBucket   = Math.floor(now / 86_400_000);
        return {
            hourKey: `${REDIS_PREFIX}:${this.userId}:rl:${operationType}:hour:${accountId}:${hourBucket}`,
            dayKey:  `${REDIS_PREFIX}:${this.userId}:rl:${operationType}:day:${accountId}:${dayBucket}`,
        };
    }

    /**
     * [البند 7] حساب نسبة الـ Warm-up بناءً على عمر الحساب
     * @param {Date|string|number|null} accountCreatedAt
     */
    _warmupRatio(accountCreatedAt) {
        if (!this.cfg.warmup_enabled || !accountCreatedAt) return 1.0;
        const createdMs = new Date(accountCreatedAt).getTime();
        if (Number.isNaN(createdMs)) return 1.0;
        const ageDays = (Date.now() - createdMs) / 86_400_000;

        if (ageDays <= (this.cfg.warmup_stage1_days ?? 2)) {
            return this.cfg.warmup_stage1_ratio ?? 0.20;
        }
        if (ageDays <= (this.cfg.warmup_stage2_days ?? 7)) {
            return this.cfg.warmup_stage2_ratio ?? 0.50;
        }
        return this.cfg.warmup_full_ratio ?? 1.0;
    }

    /**
     * التحقق مما إذا كانت العملية مسموح بها لهذا الحساب (بدون زيادة العداد)
     * @returns { allowed: bool, reason?: string, resetIn?: number }
     */
    async check(accountId, operationType = 'group', accountCreatedAt = null) {
        const { hour: hourLimitRaw, day: dayLimitRaw } = this._limits(operationType);
        const ratio = this._warmupRatio(accountCreatedAt);
        const hourLimit = Math.max(1, Math.floor(hourLimitRaw * ratio));
        const dayLimit  = Math.max(1, Math.floor(dayLimitRaw * ratio));

        const { hourKey, dayKey } = this._keys(accountId, operationType);
        const [hourCount, dayCount] = await Promise.all([
            RedisCounters.get(hourKey),
            RedisCounters.get(dayKey),
        ]);

        if ((hourCount || 0) >= hourLimit) {
            const resetIn = (await RedisCounters.ttl(hourKey)) * 1000;
            return { allowed: false, reason: 'rate_limit_hour', resetIn, hourLimit, dayLimit, warmupRatio: ratio };
        }
        if ((dayCount || 0) >= dayLimit) {
            const resetIn = (await RedisCounters.ttl(dayKey)) * 1000;
            return { allowed: false, reason: 'rate_limit_day', resetIn, hourLimit, dayLimit, warmupRatio: ratio };
        }
        return { allowed: true, hourLimit, dayLimit, warmupRatio: ratio };
    }

    /** تسجيل عملية ناجحة (زيادة عدّادي الساعة واليوم ذرياً) */
    async record(accountId, operationType = 'group') {
        const { hourKey, dayKey } = this._keys(accountId, operationType);
        await Promise.all([
            RedisCounters.incrWithExpire(hourKey, SEC_PER_HOUR),
            RedisCounters.incrWithExpire(dayKey, SEC_PER_DAY),
        ]);
    }

    /** إحصاءات الاستخدام الحالي لنوع عملية معيّن */
    async stats(accountId, operationType = 'group', accountCreatedAt = null) {
        const { hour: hourLimitRaw, day: dayLimitRaw } = this._limits(operationType);
        const ratio = this._warmupRatio(accountCreatedAt);
        const hourLimit = Math.max(1, Math.floor(hourLimitRaw * ratio));
        const dayLimit  = Math.max(1, Math.floor(dayLimitRaw * ratio));
        const { hourKey, dayKey } = this._keys(accountId, operationType);

        const [hourUsed, dayUsed, hourResetIn, dayResetIn] = await Promise.all([
            RedisCounters.get(hourKey),
            RedisCounters.get(dayKey),
            RedisCounters.ttl(hourKey),
            RedisCounters.ttl(dayKey),
        ]);

        return {
            operationType,
            hourUsed: hourUsed || 0,
            hourLimit,
            dayUsed: dayUsed || 0,
            dayLimit,
            hourResetIn: hourResetIn * 1000,
            dayResetIn:  dayResetIn * 1000,
            warmupRatio: ratio,
        };
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  2. TaskDistributor — توزيع المهام على الحسابات (في الذاكرة، per-userId)
// ════════════════════════════════════════════════════════════════════════════
// ملاحظة: هذا يبقى في الذاكرة عمداً (وليس Redis) لأنه:
//   - حالة عابرة بحتة (round-robin index/load حالي) لا تحتاج بقاءً عبر deploy.
//   - كل instance يدير توزيعه الخاص لمهامه الجارية حالياً، وهذا غير حسّاس
//     أمنياً (لا يؤثر على الحظر بشكل مباشر مثل العدادات).
// لكنه الآن مفهرس بـ userId بشكل صريح (Map<userId, TaskDistributor>) في
// ProtectionService نفسه، بدل أن يكون Singleton واحد يخلط بين المستخدمين.
class TaskDistributor {
    constructor() {
        this._rrIndex    = 0;
        this._taskCounts = new Map(); // accountId → count
    }

    pick(accounts, mode = 'round_robin') {
        const active = accounts.filter(a => a.status === 'connected' && !a.is_suspended);
        if (active.length === 0) return null;

        switch (mode) {
            case 'round_robin': {
                const idx = this._rrIndex % active.length;
                this._rrIndex++;
                return active[idx];
            }
            case 'weighted': {
                const total = active.reduce((s, a) => s + (a.weight || 1), 0);
                let rand = Math.random() * total;
                for (const acc of active) {
                    rand -= (acc.weight || 1);
                    if (rand <= 0) return acc;
                }
                return active[active.length - 1];
            }
            case 'priority':
                return active.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
            case 'least_busy': {
                return active.reduce((best, a) => {
                    const countA = this._taskCounts.get(a.id) || 0;
                    const countB = this._taskCounts.get(best.id) || 0;
                    return countA < countB ? a : best;
                }, active[0]);
            }
            default:
                return active[0];
        }
    }

    assign(accountId) {
        this._taskCounts.set(accountId, (this._taskCounts.get(accountId) || 0) + 1);
    }

    release(accountId) {
        const c = this._taskCounts.get(accountId) || 0;
        if (c > 0) this._taskCounts.set(accountId, c - 1);
    }

    loadMap() {
        return Object.fromEntries(this._taskCounts.entries());
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  3. تصنيف الأخطاء [البند 8]
// ════════════════════════════════════════════════════════════════════════════
/**
 * يُصنّف رسالة/كائن خطأ Baileys أو خطأ عام إلى فئة معروفة.
 * الفئات: temporary | network | timeout | rate_limit | forbidden | banned | invalid
 * @returns {{ category: string, retryable: boolean, shouldSuspend: boolean }}
 */
function classifyError(err) {
    const msg    = String(err?.message || err || '').toLowerCase();
    const status = err?.output?.statusCode || err?.statusCode || null;

    // ── حظر صريح (Baileys DisconnectReason.forbidden = 403) ──────────────────
    if (status === 403 || msg.includes('forbidden') || msg.includes('banned') || msg.includes('account-banned')) {
        return { category: 'banned', retryable: false, shouldSuspend: true };
    }

    // ── تسجيل خروج / جلسة غير صالحة (لا فائدة من إعادة المحاولة) ────────────
    if (status === 401 || msg.includes('logged out') || msg.includes('unauthorized') || msg.includes('bad-session')) {
        return { category: 'forbidden', retryable: false, shouldSuspend: true };
    }

    // ── تحديد المعدّل من طرف واتساب نفسه ──────────────────────────────────────
    if (status === 429 || msg.includes('rate-overlimit') || msg.includes('rate limit') || msg.includes('too many requests')) {
        return { category: 'rate_limit', retryable: true, shouldSuspend: false };
    }

    // ── مهلة الاتصال ──────────────────────────────────────────────────────────
    if (msg.includes('timeout') || msg.includes('timed out') || err?.code === 'ETIMEDOUT') {
        return { category: 'timeout', retryable: true, shouldSuspend: false };
    }

    // ── أخطاء شبكة ────────────────────────────────────────────────────────────
    if (['econnreset', 'econnrefused', 'enotfound', 'epipe'].includes(err?.code?.toLowerCase?.()) ||
        msg.includes('network') || msg.includes('connection closed') || msg.includes('socket')) {
        return { category: 'network', retryable: true, shouldSuspend: false };
    }

    // ── مدخلات غير صالحة (رقم غير موجود، JID خاطئ...) — لا فائدة من الإعادة ──
    if (msg.includes('not-authorized') || msg.includes('item-not-found') || msg.includes('invalid jid') ||
        msg.includes('bad-request') || msg.includes('not a whatsapp user')) {
        return { category: 'invalid', retryable: false, shouldSuspend: false };
    }

    // ── افتراضي: خطأ مؤقت قابل لإعادة المحاولة ────────────────────────────────
    return { category: 'temporary', retryable: true, shouldSuspend: false };
}

// ════════════════════════════════════════════════════════════════════════════
//  4. ErrorMonitor — مراقبة الأخطاء (Redis-backed، per-userId)
// ════════════════════════════════════════════════════════════════════════════
class ErrorMonitor {
    constructor(userId, threshold = 5) {
        this.userId    = userId;
        this.threshold = threshold;
    }

    _key(accountId) {
        // عداد أخطاء متتالية قابلة لإعادة المحاولة فقط — يُصفَّر عند أي نجاح
        return `${REDIS_PREFIX}:${this.userId}:errcount:${accountId}`;
    }

    _logKey(accountId) {
        return `${REDIS_PREFIX}:${this.userId}:errlog:${accountId}`;
    }

    /** تسجيل خطأ وزيادة العداد فقط إذا كان قابلاً لإعادة المحاولة */
    async record(accountId, errorMsg, classification) {
        const redis = RedisManager.getCache();
        let count = 0;
        if (classification.retryable) {
            count = await RedisCounters.incrWithExpire(this._key(accountId), SEC_PER_DAY);
        } else {
            count = (await RedisCounters.get(this._key(accountId))) || 0;
        }
        try {
            const entry = JSON.stringify({ msg: errorMsg, category: classification.category, at: new Date().toISOString() });
            await redis.lpush(this._logKey(accountId), entry);
            await redis.ltrim(this._logKey(accountId), 0, 19); // آخر 20 فقط
            await redis.expire(this._logKey(accountId), SEC_PER_DAY);
        } catch (err) {
            console.error('[ErrorMonitor] record log error:', err.message);
        }
        return count;
    }

    async clear(accountId) {
        await RedisCounters.del(this._key(accountId));
    }

    async shouldDisable(accountId) {
        const count = (await RedisCounters.get(this._key(accountId))) || 0;
        return count >= this.threshold;
    }

    async stats(accountId) {
        const redis = RedisManager.getCache();
        const count = (await RedisCounters.get(this._key(accountId))) || 0;
        let errors = [];
        try {
            const raw = await redis.lrange(this._logKey(accountId), 0, 19);
            errors = raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
        } catch { /* تجاهل */ }
        return { count, lastAt: errors[0]?.at || null, errors };
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  5. SmartRetry — إعادة المحاولة الذكية (Redis-backed، per-userId)
//     تعمل فقط مع تصنيفات الأخطاء القابلة لإعادة المحاولة [البند 8]
// ════════════════════════════════════════════════════════════════════════════
class SmartRetry {
    constructor(userId, config = {}) {
        this.userId     = userId;
        this.maxRetries = config.max_retries      ?? 3;
        this.baseDelay  = config.retry_base_delay ?? 60;
        this.maxDelay   = config.retry_max_delay  ?? 1800;
    }

    _key(taskId) {
        return `${REDIS_PREFIX}:${this.userId}:retry:${taskId}`;
    }

    async canRetry(taskId) {
        const attempts = (await RedisCounters.get(this._key(taskId))) || 0;
        return attempts < this.maxRetries;
    }

    async nextDelay(taskId) {
        const attempts = (await RedisCounters.get(this._key(taskId))) || 0;
        const delay  = Math.min(this.baseDelay * Math.pow(2, attempts), this.maxDelay);
        const jitter = delay * 0.1 * Math.random(); // ±10% jitter
        return Math.floor(delay + jitter);
    }

    async increment(taskId) {
        await RedisCounters.incrWithExpire(this._key(taskId), Math.max(this.maxDelay * 4, SEC_PER_DAY));
    }

    async reset(taskId) {
        await RedisCounters.del(this._key(taskId));
    }

    async attemptsFor(taskId) {
        return (await RedisCounters.get(this._key(taskId))) || 0;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  6. SecurityLogger — السجل الأمني (PostgreSQL — لا تغيير وظيفي)
// ════════════════════════════════════════════════════════════════════════════
class SecurityLogger {
    static async log(userId, accountId, eventType, message, meta = {}) {
        try {
            const pool = getPool();
            const id   = crypto.randomUUID();
            await pool.query(
                `INSERT INTO protection_security_logs
                    (id, user_id, account_id, event_type, message, metadata)
                 VALUES ($1,$2,$3,$4,$5,$6)`,
                [id, userId, accountId, eventType, message, JSON.stringify(meta)]
            );
        } catch (err) {
            console.error('[SecurityLogger] Failed to write log:', err.message);
        }
    }

    static async fetch(userId, filters = {}) {
        const pool    = getPool();
        const clauses = ['user_id = $1'];
        const params  = [userId];
        let   pi      = 2;

        if (filters.accountId) { clauses.push(`account_id = $${pi++}`); params.push(filters.accountId); }
        if (filters.eventType) { clauses.push(`event_type = $${pi++}`); params.push(filters.eventType); }
        if (filters.from)      { clauses.push(`created_at >= $${pi++}`); params.push(filters.from); }
        if (filters.to)        { clauses.push(`created_at <= $${pi++}`); params.push(filters.to); }

        const limit  = Math.min(filters.limit  || 100, 500);
        const offset = filters.offset || 0;

        const { rows } = await pool.query(
            `SELECT * FROM protection_security_logs
             WHERE ${clauses.join(' AND ')}
             ORDER BY created_at DESC
             LIMIT $${pi++} OFFSET $${pi++}`,
            [...params, limit, offset]
        );
        const count = await pool.query(
            `SELECT COUNT(*) FROM protection_security_logs WHERE ${clauses.join(' AND ')}`,
            params.slice(0, pi - 3)
        );
        return { logs: rows, total: parseInt(count.rows[0].count) };
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  7. ProtectionService — الخدمة الرئيسية
// ════════════════════════════════════════════════════════════════════════════
class ProtectionService {

    constructor() {
        this._configs      = new Map();   // userId → config object (cache في الذاكرة فقط، المصدر الحقيقي PostgreSQL)
        this._limiters     = new Map();   // userId → RateLimiter
        this._monitors     = new Map();   // userId → ErrorMonitor
        this._retryers     = new Map();   // userId → SmartRetry
        this._distributors = new Map();   // userId → TaskDistributor  [البند 4: Multi-Tenant]
    }

    _suspendedKey(userId) {
        return `${REDIS_PREFIX}:${userId}:suspended`;
    }

    _distributor(userId) {
        if (!this._distributors.has(userId)) {
            this._distributors.set(userId, new TaskDistributor());
        }
        return this._distributors.get(userId);
    }

    // ── تهيئة / حفظ ضبط الحماية ──────────────────────────────────────────────
    async loadConfig(userId) {
        if (this._configs.has(userId)) return this._configs.get(userId);

        const pool  = getPool();
        const { rows } = await pool.query(
            'SELECT * FROM protection_config WHERE user_id = $1 LIMIT 1',
            [userId]
        );
        const cfg = rows[0]
            ? { ...DEFAULT_CONFIG, ...rows[0] }
            : { ...DEFAULT_CONFIG, user_id: userId };

        this._configs.set(userId, cfg);
        this._limiters.set(userId, new RateLimiter(userId, cfg));
        this._monitors.set(userId, new ErrorMonitor(userId, cfg.error_threshold));
        this._retryers.set(userId, new SmartRetry(userId, cfg));
        return cfg;
    }

    async saveConfig(userId, updates) {
        const pool    = getPool();
        const current = await this.loadConfig(userId);
        const merged  = { ...current, ...updates, user_id: userId, updated_at: new Date() };

        const { rows } = await pool.query(
            'SELECT id FROM protection_config WHERE user_id = $1',
            [userId]
        );
        if (rows.length > 0) {
            await pool.query(
                `UPDATE protection_config SET
                    max_ops_per_hour=$1, max_ops_per_day=$2,
                    min_delay_between_ops=$3, max_delay_between_ops=$4,
                    distribution_mode=$5, error_threshold=$6,
                    auto_disable_on_error=$7, retry_enabled=$8,
                    max_retries=$9, retry_base_delay=$10, retry_max_delay=$11,
                    log_retention_days=$12, is_active=$13,
                    group_max_ops_per_hour=$14, group_max_ops_per_day=$15,
                    group_min_delay_between_ops=$16, group_max_delay_between_ops=$17,
                    private_max_ops_per_hour=$18, private_max_ops_per_day=$19,
                    private_min_delay_between_ops=$20, private_max_delay_between_ops=$21,
                    warmup_enabled=$22, updated_at=NOW()
                 WHERE user_id=$23`,
                [
                    merged.max_ops_per_hour, merged.max_ops_per_day,
                    merged.min_delay_between_ops, merged.max_delay_between_ops,
                    merged.distribution_mode, merged.error_threshold,
                    merged.auto_disable_on_error, merged.retry_enabled,
                    merged.max_retries, merged.retry_base_delay, merged.retry_max_delay,
                    merged.log_retention_days, merged.is_active !== false,
                    merged.group_max_ops_per_hour, merged.group_max_ops_per_day,
                    merged.group_min_delay_between_ops, merged.group_max_delay_between_ops,
                    merged.private_max_ops_per_hour, merged.private_max_ops_per_day,
                    merged.private_min_delay_between_ops, merged.private_max_delay_between_ops,
                    merged.warmup_enabled !== false,
                    userId,
                ]
            );
        } else {
            const id = crypto.randomUUID();
            await pool.query(
                `INSERT INTO protection_config
                    (id, user_id, max_ops_per_hour, max_ops_per_day,
                     min_delay_between_ops, max_delay_between_ops,
                     distribution_mode, error_threshold, auto_disable_on_error,
                     retry_enabled, max_retries, retry_base_delay, retry_max_delay,
                     log_retention_days, is_active,
                     group_max_ops_per_hour, group_max_ops_per_day,
                     group_min_delay_between_ops, group_max_delay_between_ops,
                     private_max_ops_per_hour, private_max_ops_per_day,
                     private_min_delay_between_ops, private_max_delay_between_ops,
                     warmup_enabled)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
                [
                    id, userId,
                    merged.max_ops_per_hour, merged.max_ops_per_day,
                    merged.min_delay_between_ops, merged.max_delay_between_ops,
                    merged.distribution_mode, merged.error_threshold,
                    merged.auto_disable_on_error ?? true,
                    merged.retry_enabled ?? true,
                    merged.max_retries, merged.retry_base_delay, merged.retry_max_delay,
                    merged.log_retention_days, merged.is_active !== false,
                    merged.group_max_ops_per_hour, merged.group_max_ops_per_day,
                    merged.group_min_delay_between_ops, merged.group_max_delay_between_ops,
                    merged.private_max_ops_per_hour, merged.private_max_ops_per_day,
                    merged.private_min_delay_between_ops, merged.private_max_delay_between_ops,
                    merged.warmup_enabled !== false,
                ]
            );
        }

        // أعد إنشاء الكائنات المرتبطة بعد تغيير الإعدادات
        this._configs.delete(userId);
        this._limiters.delete(userId);
        this._monitors.delete(userId);
        this._retryers.delete(userId);

        await SecurityLogger.log(userId, null, 'config_change', 'تم تحديث إعدادات الحماية', updates);
        return this.loadConfig(userId);
    }

    /**
     * ── التحقق قبل تنفيذ أي عملية إرسال ─────────────────────────────────────
     * @param {string} userId
     * @param {string} accountId
     * @param {object} [opts]
     * @param {'group'|'private'} [opts.operationType='group']  [البند 6]
     * @param {string|Date|number|null} [opts.accountCreatedAt=null]  [البند 7]
     */
    async checkOperation(userId, accountId, opts = {}) {
        const operationType    = opts.operationType ?? 'group';
        const accountCreatedAt = opts.accountCreatedAt ?? null;

        const cfg = await this.loadConfig(userId);
        if (!cfg.is_active) return { allowed: true };

        // هل الحساب موقوف؟ (Redis Set — بدل Set في الذاكرة)
        const isSuspended = await RedisCounters.sismember(this._suspendedKey(userId), accountId);
        if (isSuspended) {
            return { allowed: false, reason: 'account_suspended', message: 'الحساب موقوف تلقائياً بسبب أخطاء متكررة أو حظر' };
        }

        // rate limiting (مفصول حسب operationType ومع مراعاة Warm-up)
        const limiter = this._limiters.get(userId);
        const rl = await limiter.check(accountId, operationType, accountCreatedAt);
        if (!rl.allowed) {
            await SecurityLogger.log(userId, accountId, 'rate_limit',
                `تجاوز حد ${rl.reason === 'rate_limit_hour' ? 'الساعي' : 'اليومي'} (${operationType})`,
                { reason: rl.reason, resetIn: rl.resetIn, operationType, warmupRatio: rl.warmupRatio }
            );
            return {
                allowed: false, reason: rl.reason, resetIn: rl.resetIn, operationType,
                message: rl.reason === 'rate_limit_hour'
                    ? `تجاوزت الحد الساعي (${rl.hourLimit} عمليات/ساعة${rl.warmupRatio < 1 ? ' — حساب جديد تحت Warm-up' : ''})`
                    : `تجاوزت الحد اليومي (${rl.dayLimit} عمليات/يوم${rl.warmupRatio < 1 ? ' — حساب جديد تحت Warm-up' : ''})`,
            };
        }

        return { allowed: true, cfg, operationType, warmupRatio: rl.warmupRatio };
    }

    /** تسجيل عملية ناجحة */
    async recordSuccess(userId, accountId, taskId, meta = {}) {
        const operationType = meta.operationType ?? 'group';

        const limiter = this._limiters.get(userId);
        if (limiter) await limiter.record(accountId, operationType);

        const monitor = this._monitors.get(userId);
        if (monitor) await monitor.clear(accountId); // أخطاء متتالية قابلة لإعادة المحاولة → تصفير بعد النجاح

        const retryer = this._retryers.get(userId);
        if (retryer && taskId) await retryer.reset(taskId);

        this._distributor(userId).release(accountId);

        await SecurityLogger.log(userId, accountId, 'join_success',
            'تمت العملية بنجاح', { taskId, ...meta });
    }

    /**
     * تسجيل فشل وتشغيل منطق الحماية [البند 8: تصنيف الأخطاء]
     * @param {object} [meta]
     * @param {'group'|'private'} [meta.operationType='group']
     * @param {object} [meta.errorObject]  كائن الخطأ الأصلي (لتصنيف أدق من classifyError)
     */
    async recordFailure(userId, accountId, taskId, errorMsg, meta = {}) {
        const operationType = meta.operationType ?? 'group';
        const cfg     = await this.loadConfig(userId);
        const monitor = this._monitors.get(userId);

        // [البند 8] تصنيف الخطأ أولاً
        const classification = classifyError(meta.errorObject || { message: errorMsg });

        // ── حظر فوري دون انتظار وصول عتبة الأخطاء ─────────────────────────────
        if (classification.shouldSuspend) {
            await this.suspendAccount(userId, accountId, `auto_${classification.category}`);
            await SecurityLogger.log(userId, accountId, 'auto_disable',
                `تم إيقاف الحساب فوراً — تصنيف الخطأ: ${classification.category}`,
                { errorMsg, category: classification.category, ...meta }
            );
            this._distributor(userId).release(accountId);
            return { shouldRetry: false, suspended: true, errorCategory: classification.category };
        }

        if (monitor) {
            const count = await monitor.record(accountId, errorMsg, classification);

            if (classification.retryable && cfg.auto_disable_on_error && count >= cfg.error_threshold) {
                await this.suspendAccount(userId, accountId, 'error_threshold_exceeded');
                await SecurityLogger.log(userId, accountId, 'auto_disable',
                    `تم إيقاف الحساب تلقائياً بعد ${cfg.error_threshold} أخطاء متتالية قابلة لإعادة المحاولة`,
                    { errorMsg, category: classification.category, ...meta }
                );
                this._distributor(userId).release(accountId);
                return { shouldRetry: false, suspended: true, errorCategory: classification.category };
            }
        }

        this._distributor(userId).release(accountId);
        await SecurityLogger.log(userId, accountId, 'join_failed', errorMsg,
            { taskId, category: classification.category, operationType, ...meta });

        // [البند 8] SmartRetry يعمل فقط مع الأخطاء القابلة لإعادة المحاولة
        if (classification.retryable && cfg.retry_enabled && taskId) {
            const retryer = this._retryers.get(userId);
            if (retryer && await retryer.canRetry(taskId)) {
                const delay = await retryer.nextDelay(taskId);
                await retryer.increment(taskId);
                const attempt = await retryer.attemptsFor(taskId);
                await SecurityLogger.log(userId, accountId, 'retry',
                    `إعادة المحاولة ${attempt}/${cfg.max_retries} بعد ${delay}ث (${classification.category})`,
                    { taskId, delay, attempt, category: classification.category }
                );
                return { shouldRetry: true, delay, attempt, errorCategory: classification.category };
            }
        }
        return { shouldRetry: false, errorCategory: classification.category };
    }

    // ── إدارة تعليق/استئناف الحسابات ────────────────────────────────────────
    async suspendAccount(userId, accountId, reason = 'manual') {
        await RedisCounters.sadd(this._suspendedKey(userId), accountId);
        await this._persistSuspension(accountId, true, reason);
        await SecurityLogger.log(userId, accountId, 'auto_disable',
            `تم إيقاف الحساب: ${reason}`, { reason });
    }

    async resumeAccount(userId, accountId) {
        await RedisCounters.srem(this._suspendedKey(userId), accountId);
        const monitor = this._monitors.get(userId);
        if (monitor) await monitor.clear(accountId);
        await this._persistSuspension(accountId, false, null);
        await SecurityLogger.log(userId, accountId, 'resume',
            'تم استئناف تشغيل الحساب', {});
    }

    async isSuspended(userId, accountId) {
        return RedisCounters.sismember(this._suspendedKey(userId), accountId);
    }

    async _persistSuspension(accountId, suspended, reason = null) {
        try {
            const pool = getPool();
            await pool.query(
                `INSERT INTO protection_account_state (account_id, is_suspended, suspended_at, suspend_reason, updated_at)
                 VALUES ($1, $2, $3, $4, NOW())
                 ON CONFLICT (account_id) DO UPDATE
                   SET is_suspended=$2, suspended_at=$3, suspend_reason=$4, updated_at=NOW()`,
                [accountId, suspended, suspended ? new Date() : null, reason]
            );
        } catch (err) {
            console.error('[ProtectionService] _persistSuspension error:', err.message);
        }
    }

    // ── توزيع المهام ──────────────────────────────────────────────────────────
    async pickAccount(userId, accounts) {
        const cfg = await this.loadConfig(userId);
        const suspendedIds = new Set(await RedisCounters.smembers(this._suspendedKey(userId)));
        const available = accounts.filter(a =>
            a.status === 'connected' && !suspendedIds.has(a.id)
        );
        const distributor = this._distributor(userId);
        const picked = distributor.pick(available, cfg.distribution_mode);
        if (picked) distributor.assign(picked.id);
        return picked;
    }

    /**
     * ── تأخير عشوائي آمن بين العمليات [البند 1 و 2] ─────────────────────────
     * يستبدل أي setTimeout/sleep/delay ثابت في أي خدمة إرسال.
     * الصيغة: baseDelay + random(0..40%) كما هو مطلوب، مع احترام min/max من
     * الإعدادات (ومفصولة حسب operationType إن طُلب).
     * @param {string} userId
     * @param {'group'|'private'} [operationType='group']
     */
    async safeDelay(userId, operationType = 'group') {
        const cfg = await this.loadConfig(userId);
        const min = operationType === 'private'
            ? (cfg.private_min_delay_between_ops ?? cfg.min_delay_between_ops)
            : (cfg.group_min_delay_between_ops   ?? cfg.min_delay_between_ops);
        const max = operationType === 'private'
            ? (cfg.private_max_delay_between_ops ?? cfg.max_delay_between_ops)
            : (cfg.group_max_delay_between_ops   ?? cfg.max_delay_between_ops);

        // baseDelay + random(0..40%) — jitter منسوب لقاعدة عشوائية بين min/max
        const base   = min * 1000;
        const span   = Math.max(0, (max - min) * 1000);
        const jitter = span * 0.4 * Math.random();
        const randomPortion = Math.random() * (span - jitter);
        const ms = Math.floor(base + randomPortion + jitter);

        return new Promise(res => setTimeout(res, ms));
    }

    // ── إحصاءات شاملة ────────────────────────────────────────────────────────
    async getStats(userId, accounts = []) {
        const cfg      = await this.loadConfig(userId);
        const limiter   = this._limiters.get(userId);
        const monitor   = this._monitors.get(userId);
        const distributor = this._distributor(userId);
        const suspendedIds = new Set(await RedisCounters.smembers(this._suspendedKey(userId)));

        const accountStats = await Promise.all(accounts.map(async a => ({
            id:          a.id,
            name:        a.name || a.phone_number || a.id,
            status:      a.status,
            is_suspended: suspendedIds.has(a.id),
            errors:      monitor ? await monitor.stats(a.id) : { count: 0 },
            load:        distributor.loadMap()[a.id] || 0,
            rateLimits: {
                group:   limiter ? await limiter.stats(a.id, 'group', a.created_at) : {},
                private: limiter ? await limiter.stats(a.id, 'private', a.created_at) : {},
            },
        })));

        const pool = getPool();
        const { rows: recentLogs } = await pool.query(
            `SELECT event_type, COUNT(*) as cnt
             FROM protection_security_logs
             WHERE user_id=$1 AND created_at > NOW() - INTERVAL '24 hours'
             GROUP BY event_type`,
            [userId]
        );
        const logSummary = Object.fromEntries(recentLogs.map(r => [r.event_type, parseInt(r.cnt)]));

        return {
            config:       cfg,
            accountStats,
            logSummary,
            suspendedCount: accounts.filter(a => suspendedIds.has(a.id)).length,
            activeCount:    accounts.filter(a => !suspendedIds.has(a.id) && a.status === 'connected').length,
            distributorLoad: distributor.loadMap(),
        };
    }

    // ── تنظيف السجلات القديمة ─────────────────────────────────────────────────
    async cleanOldLogs(userId) {
        const cfg  = await this.loadConfig(userId);
        const pool = getPool();
        const { rowCount } = await pool.query(
            `DELETE FROM protection_security_logs
             WHERE user_id=$1 AND created_at < NOW() - INTERVAL '${cfg.log_retention_days} days'`,
            [userId]
        );
        return rowCount;
    }

    // ── نسخة Singleton (الخدمة نفسها Singleton، لكن كل حالتها الداخلية معزولة per-userId) ──
    static getInstance() {
        if (!ProtectionService._instance) {
            ProtectionService._instance = new ProtectionService();
        }
        return ProtectionService._instance;
    }
}

ProtectionService._instance = null;

module.exports = {
    ProtectionService,
    SecurityLogger,
    RateLimiter,
    TaskDistributor,
    ErrorMonitor,
    SmartRetry,
    classifyError,
    DEFAULT_CONFIG,
};
