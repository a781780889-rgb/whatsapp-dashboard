'use strict';
/**
 * ProtectionService — نظام الحماية المتقدم
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * المكونات:
 *  1. RateLimiter       — تحديد سرعة العمليات (حد لكل ساعة/يوم)
 *  2. TaskDistributor   — توزيع المهام على الحسابات (round-robin / weighted)
 *  3. JoinScheduler     — جدولة الانضمامات بفواصل زمنية آمنة
 *  4. ErrorMonitor      — مراقبة الأخطاء وإحصاءها لكل حساب
 *  5. AutoDisabler      — إيقاف الحساب تلقائياً عند تجاوز حد الأخطاء
 *  6. SmartRetry        — إعادة المحاولة بأسلوب exponential-backoff
 *  7. SecurityLogger    — سجل أمني كامل لكل حدث
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const { getPool } = require('../../lib/postgres');
const crypto      = require('crypto');

// ─── ثوابت ──────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    max_ops_per_hour:       20,
    max_ops_per_day:       100,
    min_delay_between_ops:  30,   // ثانية
    max_delay_between_ops: 120,   // ثانية
    distribution_mode:     'round_robin',  // round_robin | weighted | priority
    error_threshold:         5,   // أخطاء متتالية قبل إيقاف الحساب
    auto_disable_on_error: true,
    retry_enabled:         true,
    max_retries:             3,
    retry_base_delay:       60,   // ثانية (يتضاعف مع كل محاولة)
    retry_max_delay:      1800,   // 30 دقيقة
    log_retention_days:     30,
};

// ─── خريطة المؤقتات في الذاكرة ───────────────────────────────────────────────
const _scheduledTimers = new Map();   // taskId → TimeoutHandle
const _retryTimers     = new Map();   // taskId → TimeoutHandle

// ════════════════════════════════════════════════════════════════════════════
//  1. RateLimiter — تحديد سرعة العمليات
// ════════════════════════════════════════════════════════════════════════════
class RateLimiter {
    constructor(config = {}) {
        this.cfg = { ...DEFAULT_CONFIG, ...config };
        // ذاكرة مؤقتة: accountId → { hourCount, dayCount, hourReset, dayReset }
        this._counters = new Map();
    }

    _getCounter(accountId) {
        const now  = Date.now();
        const hour = Math.floor(now / 3_600_000) * 3_600_000;
        const day  = Math.floor(now / 86_400_000) * 86_400_000;

        if (!this._counters.has(accountId)) {
            this._counters.set(accountId, { hourCount: 0, dayCount: 0, hourReset: hour + 3_600_000, dayReset: day + 86_400_000 });
        }

        const c = this._counters.get(accountId);
        if (now >= c.hourReset) { c.hourCount = 0; c.hourReset = hour + 3_600_000; }
        if (now >= c.dayReset)  { c.dayCount  = 0; c.dayReset  = day  + 86_400_000; }
        return c;
    }

    /**
     * التحقق مما إذا كانت العملية مسموح بها لهذا الحساب
     * @returns { allowed: bool, reason?: string, resetIn?: number }
     */
    check(accountId) {
        const c = this._getCounter(accountId);
        if (c.hourCount >= this.cfg.max_ops_per_hour) {
            return { allowed: false, reason: 'rate_limit_hour', resetIn: c.hourReset - Date.now() };
        }
        if (c.dayCount >= this.cfg.max_ops_per_day) {
            return { allowed: false, reason: 'rate_limit_day', resetIn: c.dayReset - Date.now() };
        }
        return { allowed: true };
    }

    /** تسجيل عملية ناجحة */
    record(accountId) {
        const c = this._getCounter(accountId);
        c.hourCount++;
        c.dayCount++;
    }

    /** إحصاءات الاستخدام الحالي */
    stats(accountId) {
        const c = this._getCounter(accountId);
        return {
            hourUsed:  c.hourCount,
            hourLimit: this.cfg.max_ops_per_hour,
            dayUsed:   c.dayCount,
            dayLimit:  this.cfg.max_ops_per_day,
            hourResetIn: Math.max(0, c.hourReset - Date.now()),
            dayResetIn:  Math.max(0, c.dayReset  - Date.now()),
        };
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  2. TaskDistributor — توزيع المهام على الحسابات
// ════════════════════════════════════════════════════════════════════════════
class TaskDistributor {
    constructor() {
        this._rrIndex = 0;           // مؤشر round-robin
        this._taskCounts = new Map(); // accountId → count
    }

    /**
     * اختيار الحساب الأنسب لتنفيذ المهمة
     * @param {Array<{id, weight?, priority?}>} accounts   — الحسابات المتاحة
     * @param {string} mode  — round_robin | weighted | priority | least_busy
     * @returns {object|null}
     */
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
                // وزن افتراضي 1 إذا لم يُحدد
                const total = active.reduce((s, a) => s + (a.weight || 1), 0);
                let rand = Math.random() * total;
                for (const acc of active) {
                    rand -= (acc.weight || 1);
                    if (rand <= 0) return acc;
                }
                return active[active.length - 1];
            }
            case 'priority':
                // أعلى priority أولاً
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

    /** تسجيل مهمة جديدة على حساب */
    assign(accountId) {
        this._taskCounts.set(accountId, (this._taskCounts.get(accountId) || 0) + 1);
    }

    /** إنهاء مهمة */
    release(accountId) {
        const c = this._taskCounts.get(accountId) || 0;
        if (c > 0) this._taskCounts.set(accountId, c - 1);
    }

    /** عدد المهام الجارية لكل حساب */
    loadMap() {
        return Object.fromEntries(this._taskCounts.entries());
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  3. ErrorMonitor — مراقبة الأخطاء
// ════════════════════════════════════════════════════════════════════════════
class ErrorMonitor {
    constructor(threshold = 5) {
        this.threshold = threshold;
        this._errors = new Map(); // accountId → { count, lastAt, errors[] }
    }

    record(accountId, errorMsg) {
        if (!this._errors.has(accountId)) {
            this._errors.set(accountId, { count: 0, lastAt: null, errors: [] });
        }
        const e = this._errors.get(accountId);
        e.count++;
        e.lastAt = new Date().toISOString();
        e.errors.push({ msg: errorMsg, at: e.lastAt });
        if (e.errors.length > 20) e.errors.shift(); // احتفظ بآخر 20
    }

    clear(accountId) {
        this._errors.delete(accountId);
    }

    shouldDisable(accountId) {
        const e = this._errors.get(accountId);
        return e ? e.count >= this.threshold : false;
    }

    stats(accountId) {
        return this._errors.get(accountId) || { count: 0, lastAt: null, errors: [] };
    }

    allStats() {
        return Object.fromEntries(this._errors.entries());
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  4. SmartRetry — إعادة المحاولة الذكية (Exponential Backoff)
// ════════════════════════════════════════════════════════════════════════════
class SmartRetry {
    constructor(config = {}) {
        this.maxRetries   = config.max_retries   ?? 3;
        this.baseDelay    = config.retry_base_delay ?? 60;
        this.maxDelay     = config.retry_max_delay  ?? 1800;
        this._attempts    = new Map(); // taskId → attemptCount
    }

    canRetry(taskId) {
        return (this._attempts.get(taskId) || 0) < this.maxRetries;
    }

    nextDelay(taskId) {
        const attempt = this._attempts.get(taskId) || 0;
        // exponential: baseDelay * 2^attempt + jitter
        const delay = Math.min(this.baseDelay * Math.pow(2, attempt), this.maxDelay);
        const jitter = delay * 0.1 * Math.random(); // ±10% jitter
        return Math.floor(delay + jitter);
    }

    increment(taskId) {
        this._attempts.set(taskId, (this._attempts.get(taskId) || 0) + 1);
    }

    reset(taskId) {
        this._attempts.delete(taskId);
    }

    attemptsFor(taskId) {
        return this._attempts.get(taskId) || 0;
    }
}

// ════════════════════════════════════════════════════════════════════════════
//  5. SecurityLogger — السجل الأمني (PostgreSQL)
// ════════════════════════════════════════════════════════════════════════════
class SecurityLogger {
    /**
     * @param {string} userId
     * @param {string|null} accountId
     * @param {string} eventType  — rate_limit | error | auto_disable | retry |
     *                              join_success | join_failed | config_change | resume
     * @param {string} message
     * @param {object} [meta]
     */
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
//  6. ProtectionService — الخدمة الرئيسية
// ════════════════════════════════════════════════════════════════════════════
class ProtectionService {

    constructor() {
        this._configs    = new Map();   // userId → config object
        this._limiters   = new Map();   // userId → RateLimiter
        this._monitors   = new Map();   // userId → ErrorMonitor
        this._retryers   = new Map();   // userId → SmartRetry
        this._distributor = new TaskDistributor();
        this._suspended  = new Set();   // accountIds that are auto-suspended
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
        this._limiters.set(userId, new RateLimiter(cfg));
        this._monitors.set(userId, new ErrorMonitor(cfg.error_threshold));
        this._retryers.set(userId, new SmartRetry(cfg));
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
                    log_retention_days=$12, is_active=$13, updated_at=NOW()
                 WHERE user_id=$14`,
                [
                    merged.max_ops_per_hour, merged.max_ops_per_day,
                    merged.min_delay_between_ops, merged.max_delay_between_ops,
                    merged.distribution_mode, merged.error_threshold,
                    merged.auto_disable_on_error, merged.retry_enabled,
                    merged.max_retries, merged.retry_base_delay, merged.retry_max_delay,
                    merged.log_retention_days, merged.is_active !== false,
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
                     log_retention_days, is_active)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                [
                    id, userId,
                    merged.max_ops_per_hour, merged.max_ops_per_day,
                    merged.min_delay_between_ops, merged.max_delay_between_ops,
                    merged.distribution_mode, merged.error_threshold,
                    merged.auto_disable_on_error ?? true,
                    merged.retry_enabled ?? true,
                    merged.max_retries, merged.retry_base_delay, merged.retry_max_delay,
                    merged.log_retention_days, merged.is_active !== false,
                ]
            );
        }

        // أعد إنشاء الكائنات بعد تغيير الإعدادات
        this._configs.delete(userId);
        this._limiters.delete(userId);
        this._monitors.delete(userId);
        this._retryers.delete(userId);

        await SecurityLogger.log(userId, null, 'config_change', 'تم تحديث إعدادات الحماية', updates);
        return this.loadConfig(userId);
    }

    // ── التحقق قبل تنفيذ أي عملية ───────────────────────────────────────────
    async checkOperation(userId, accountId) {
        const cfg     = await this.loadConfig(userId);
        if (!cfg.is_active) return { allowed: true };

        // هل الحساب موقوف؟
        if (this._suspended.has(accountId)) {
            return { allowed: false, reason: 'account_suspended', message: 'الحساب موقوف تلقائياً بسبب أخطاء متكررة' };
        }

        // rate limiting
        const limiter = this._limiters.get(userId);
        const rl      = limiter.check(accountId);
        if (!rl.allowed) {
            await SecurityLogger.log(userId, accountId, 'rate_limit',
                `تجاوز حد ${rl.reason === 'rate_limit_hour' ? 'الساعي' : 'اليومي'}`,
                { reason: rl.reason, resetIn: rl.resetIn }
            );
            return { allowed: false, reason: rl.reason, resetIn: rl.resetIn,
                     message: rl.reason === 'rate_limit_hour'
                         ? `تجاوزت الحد الساعي (${cfg.max_ops_per_hour} عمليات/ساعة)`
                         : `تجاوزت الحد اليومي (${cfg.max_ops_per_day} عمليات/يوم)` };
        }

        return { allowed: true, cfg };
    }

    /** تسجيل عملية ناجحة */
    async recordSuccess(userId, accountId, taskId, meta = {}) {
        const limiter = this._limiters.get(userId);
        if (limiter) limiter.record(accountId);

        const monitor = this._monitors.get(userId);
        if (monitor) monitor.clear(accountId); // أخطاء متتالية → تصفير بعد النجاح

        const retryer = this._retryers.get(userId);
        if (retryer && taskId) retryer.reset(taskId);

        this._distributor.release(accountId);

        await SecurityLogger.log(userId, accountId, 'join_success',
            'تمت العملية بنجاح', { taskId, ...meta });
    }

    /** تسجيل فشل وتشغيل منطق الحماية */
    async recordFailure(userId, accountId, taskId, errorMsg, meta = {}) {
        const cfg     = await this.loadConfig(userId);
        const monitor = this._monitors.get(userId);

        if (monitor) {
            monitor.record(accountId, errorMsg);

            if (cfg.auto_disable_on_error && monitor.shouldDisable(accountId)) {
                this._suspended.add(accountId);
                await this._persistSuspension(accountId, true);
                await SecurityLogger.log(userId, accountId, 'auto_disable',
                    `تم إيقاف الحساب تلقائياً بعد ${cfg.error_threshold} أخطاء متتالية`,
                    { errorMsg, ...meta }
                );
            }
        }

        this._distributor.release(accountId);
        await SecurityLogger.log(userId, accountId, 'join_failed', errorMsg, { taskId, ...meta });

        // هل نُعيد المحاولة؟
        if (cfg.retry_enabled && taskId) {
            const retryer = this._retryers.get(userId);
            if (retryer && retryer.canRetry(taskId)) {
                const delay = retryer.nextDelay(taskId);
                retryer.increment(taskId);
                await SecurityLogger.log(userId, accountId, 'retry',
                    `إعادة المحاولة ${retryer.attemptsFor(taskId)}/${cfg.max_retries} بعد ${delay}ث`,
                    { taskId, delay, attempt: retryer.attemptsFor(taskId) }
                );
                return { shouldRetry: true, delay, attempt: retryer.attemptsFor(taskId) };
            }
        }
        return { shouldRetry: false };
    }

    // ── إدارة تعليق/استئناف الحسابات ────────────────────────────────────────
    async suspendAccount(userId, accountId, reason = 'manual') {
        this._suspended.add(accountId);
        await this._persistSuspension(accountId, true);
        await SecurityLogger.log(userId, accountId, 'auto_disable',
            `تم إيقاف الحساب: ${reason}`, { reason });
    }

    async resumeAccount(userId, accountId) {
        this._suspended.delete(accountId);
        const monitor = this._monitors.get(userId);
        if (monitor) monitor.clear(accountId);
        await this._persistSuspension(accountId, false);
        await SecurityLogger.log(userId, accountId, 'resume',
            'تم استئناف تشغيل الحساب', {});
    }

    async _persistSuspension(accountId, suspended) {
        try {
            const pool = getPool();
            await pool.query(
                `INSERT INTO protection_account_state (account_id, is_suspended, suspended_at, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (account_id) DO UPDATE
                   SET is_suspended=$2, suspended_at=$3, updated_at=NOW()`,
                [accountId, suspended, suspended ? new Date() : null]
            );
        } catch (err) {
            console.error('[ProtectionService] _persistSuspension error:', err.message);
        }
    }

    // ── توزيع المهام ──────────────────────────────────────────────────────────
    async pickAccount(userId, accounts) {
        const cfg = await this.loadConfig(userId);
        const available = accounts.filter(a =>
            a.status === 'connected' && !this._suspended.has(a.id)
        );
        const picked = this._distributor.pick(available, cfg.distribution_mode);
        if (picked) this._distributor.assign(picked.id);
        return picked;
    }

    // ── تأخير عشوائي آمن بين العمليات ───────────────────────────────────────
    async safeDelay(userId) {
        const cfg = await this.loadConfig(userId);
        const min = cfg.min_delay_between_ops * 1000;
        const max = cfg.max_delay_between_ops * 1000;
        const ms  = Math.floor(min + Math.random() * (max - min));
        return new Promise(res => setTimeout(res, ms));
    }

    // ── إحصاءات شاملة ────────────────────────────────────────────────────────
    async getStats(userId, accounts = []) {
        const cfg     = await this.loadConfig(userId);
        const limiter = this._limiters.get(userId);
        const monitor = this._monitors.get(userId);

        const accountStats = accounts.map(a => ({
            id:          a.id,
            name:        a.name || a.phone_number || a.id,
            status:      a.status,
            is_suspended: this._suspended.has(a.id),
            errors:      monitor ? monitor.stats(a.id) : { count: 0 },
            load:        this._distributor.loadMap()[a.id] || 0,
            rateLimits:  limiter ? limiter.stats(a.id) : {},
        }));

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
            suspendedCount: accounts.filter(a => this._suspended.has(a.id)).length,
            activeCount:    accounts.filter(a => !this._suspended.has(a.id) && a.status === 'connected').length,
            distributorLoad: this._distributor.loadMap(),
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

    // ── نسخة Singleton ───────────────────────────────────────────────────────
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
    DEFAULT_CONFIG,
};
