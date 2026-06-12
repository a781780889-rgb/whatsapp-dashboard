'use strict';
/**
 * AutoRecoveryEngine.js — FIX-10: محرك الاسترداد التلقائي الذكي
 *
 * المسؤوليات:
 *  1. Exponential Backoff مع Jitter لتجنب thundering herd
 *  2. تفريق بين نوعين من الأخطاء:
 *     - auth_failure (401/loggedOut/badSession/connectionReplaced):
 *       يحتاج QR جديد — لا فائدة من إعادة الاتصال تلقائياً
 *     - network_error (408/428/connectionLost/timedOut):
 *       يُعيد المحاولة تلقائياً حتى MAX_ATTEMPTS
 *  3. حد أقصى للمحاولات قابل للتخصيص
 *  4. إصدار أحداث EventBus عند كل مرحلة
 *  5. تسجيل سجل محاولات لكل حساب
 */

const EventBus = require('./EventBus');

// ثوابت Backoff
const BASE_DELAY_MS  = 1_000;   // 1 ثانية بداية
const MAX_DELAY_MS   = 60_000;  // دقيقة واحدة كحد أقصى
const JITTER_RATIO   = 0.3;     // ±30% عشوائية لتجنب thundering herd
const MAX_ATTEMPTS   = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '10', 10);

// رموز الانقطاع التي تعني "يحتاج QR جديد"
const AUTH_FAILURE_CODES = new Set([
    401,  // loggedOut
    500,  // badSession
    440,  // connectionReplaced
]);

// رموز الانقطاع المؤقتة (شبكة)
const NETWORK_ERROR_CODES = new Set([
    408,  // connectionLost / timedOut
    428,  // connectionClosed
    503,  // serviceUnavailable
    515,  // restartRequired — تُعالَج بشكل خاص
]);

class AutoRecoveryEngine {
    constructor() {
        // accountId → { attempts, lastAttemptAt, timerId, failureType, log[] }
        this._records = new Map();
    }

    // ─── Public API ─────────────────────────────────────────────────────────

    /**
     * تصنيف كود الانقطاع وتقرير الخطوة التالية.
     * يُعيد: { type: 'auth_failure' | 'network_error' | 'restart_required' | 'unknown', shouldRetry: bool }
     */
    classify(disconnectCode) {
        if (AUTH_FAILURE_CODES.has(disconnectCode)) {
            return { type: 'auth_failure', shouldRetry: false };
        }
        if (disconnectCode === 515) {
            return { type: 'restart_required', shouldRetry: true };
        }
        if (NETWORK_ERROR_CODES.has(disconnectCode)) {
            return { type: 'network_error', shouldRetry: true };
        }
        return { type: 'unknown', shouldRetry: true };
    }

    /**
     * جدولة محاولة إعادة الاتصال.
     * @param {string|number} accountId
     * @param {Function}      reconnectFn   — الدالة التي تُعيد الاتصال
     * @param {object}        opts
     * @param {number}        [opts.disconnectCode]
     * @param {boolean}       [opts.forceNetworkRetry=false]  تجاهل تصنيف auth_failure
     * @returns {{ scheduled: bool, attempt: number, delay: number, type: string }}
     */
    scheduleReconnect(accountId, reconnectFn, opts = {}) {
        const { disconnectCode, forceNetworkRetry = false } = opts;

        // تهيئة السجل
        if (!this._records.has(accountId)) {
            this._records.set(accountId, {
                attempts:      0,
                lastAttemptAt: null,
                timerId:       null,
                failureType:   null,
                log:           [],
            });
        }
        const rec = this._records.get(accountId);

        // إلغاء أي مؤقت سابق
        this._cancelTimer(accountId);

        // تصنيف نوع الفشل
        const { type, shouldRetry } = this.classify(disconnectCode);
        rec.failureType = type;

        // auth_failure → لا نُعيد المحاولة تلقائياً
        if (type === 'auth_failure' && !forceNetworkRetry) {
            console.warn(`[AutoRecovery] Account ${accountId}: auth_failure (code ${disconnectCode}) — needs new QR, not retrying.`);
            EventBus.emitAuthFailure(accountId);
            rec.log.push({ ts: Date.now(), type, action: 'auth_failure_emitted' });
            return { scheduled: false, attempt: rec.attempts, delay: 0, type };
        }

        // فحص الحد الأقصى
        if (rec.attempts >= MAX_ATTEMPTS) {
            console.error(`[AutoRecovery] Account ${accountId}: max attempts (${MAX_ATTEMPTS}) reached — giving up.`);
            EventBus.emitRecoveryFailed(accountId, `max_attempts_${MAX_ATTEMPTS}`);
            rec.log.push({ ts: Date.now(), type, action: 'max_attempts_reached' });
            return { scheduled: false, attempt: rec.attempts, delay: 0, type };
        }

        // حساب التأخير
        const delay = this._calcDelay(rec.attempts);
        rec.attempts++;
        rec.lastAttemptAt = Date.now();

        console.log(`[AutoRecovery] Account ${accountId}: scheduling attempt ${rec.attempts}/${MAX_ATTEMPTS} in ${delay}ms (type=${type})`);
        EventBus.emitRecoveryStarted(accountId, rec.attempts, delay);

        rec.log.push({ ts: Date.now(), type, attempt: rec.attempts, delay });
        if (rec.log.length > 30) rec.log.shift();

        // جدولة
        rec.timerId = setTimeout(() => {
            rec.timerId = null;
            console.log(`[AutoRecovery] Account ${accountId}: attempt ${rec.attempts} starting…`);
            try {
                reconnectFn();
            } catch (err) {
                console.error(`[AutoRecovery] Account ${accountId}: reconnectFn threw:`, err);
            }
        }, delay);

        return { scheduled: true, attempt: rec.attempts, delay, type };
    }

    /**
     * تسجيل نجاح الاتصال — إعادة تعيين العداد.
     */
    onSuccess(accountId) {
        const rec = this._records.get(accountId);
        if (!rec) return;
        const attempt = rec.attempts;
        this._cancelTimer(accountId);
        rec.attempts      = 0;
        rec.lastAttemptAt = null;
        rec.failureType   = null;
        rec.log.push({ ts: Date.now(), action: 'success_reset' });
        if (attempt > 0) {
            EventBus.emitRecoverySuccess(accountId, attempt);
        }
    }

    /**
     * إلغاء أي جدولة معلقة لحساب معين.
     */
    cancel(accountId) {
        this._cancelTimer(accountId);
        const rec = this._records.get(accountId);
        if (rec) {
            rec.log.push({ ts: Date.now(), action: 'cancelled' });
        }
    }

    /**
     * إعادة تعيين كاملة لحساب.
     */
    reset(accountId) {
        this._cancelTimer(accountId);
        this._records.delete(accountId);
    }

    /**
     * الحصول على إحصاءات حساب معين.
     */
    getStats(accountId) {
        const rec = this._records.get(accountId);
        if (!rec) return { attempts: 0, maxAttempts: MAX_ATTEMPTS, log: [] };
        return {
            attempts:     rec.attempts,
            maxAttempts:  MAX_ATTEMPTS,
            lastAttemptAt: rec.lastAttemptAt,
            failureType:  rec.failureType,
            nextDelay:    this._calcDelay(rec.attempts),
            log:          rec.log.slice(-10),
        };
    }

    // ─── Private ─────────────────────────────────────────────────────────────

    /**
     * حساب تأخير Exponential Backoff مع Jitter.
     * attempt=0 → ~1s, attempt=3 → ~8s, attempt=6 → ~64s → capped at 60s
     */
    _calcDelay(attempt) {
        const base   = Math.min(BASE_DELAY_MS * Math.pow(2, attempt), MAX_DELAY_MS);
        const jitter = base * JITTER_RATIO * (Math.random() * 2 - 1);
        return Math.round(Math.max(BASE_DELAY_MS, base + jitter));
    }

    _cancelTimer(accountId) {
        const rec = this._records.get(accountId);
        if (rec?.timerId) {
            clearTimeout(rec.timerId);
            rec.timerId = null;
        }
    }
}

// Singleton
const engine = new AutoRecoveryEngine();
module.exports = engine;
