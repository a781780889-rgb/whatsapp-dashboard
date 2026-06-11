'use strict';
/**
 * RuntimeAnalyzer.js — المرحلة الثانية: تحليل وقت التشغيل
 *
 * يتتبع كل محاولة اتصال من البداية للنهاية بدقة زمنية كاملة:
 *  - تسجيل كل حدث في timeline المحاولة
 *  - رصد الأخطاء المتكررة وتجميعها (Pattern Detection)
 *  - جمع إحصائيات: وقت البداية، وقت الفشل، المدة، معدل النجاح
 *  - ربط كل محاولة بسياقها الكامل (QR / Pairing / Reconnect)
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const crypto = require('crypto');

// ── أنواع الأحداث المدعومة ──────────────────────────────────────────────────
const EVENT_TYPES = {
    STATE_CHANGE:    'state_change',
    ERROR:           'error',
    QR_GENERATED:    'qr_generated',
    QR_EXPIRED:      'qr_expired',
    PAIRING_CODE:    'pairing_code',
    PAIRING_ERROR:   'pairing_error',
    CONNECTED:       'connected',
    DISCONNECTED:    'disconnected',
    RECONNECT:       'reconnect',
    SESSION_CLEARED: 'session_cleared',
    BAILEYS_EVENT:   'baileys_event',
    INFRA_CHECK:     'infra_check',
};

// ── نتائج المحاولة ─────────────────────────────────────────────────────────
const OUTCOMES = {
    CONNECTED:   'connected',
    FAILED:      'failed',
    TIMEOUT:     'timeout',
    CANCELLED:   'cancelled',
    REPLACED:    'replaced',
    LOGGED_OUT:  'logged_out',
};

// ── مستويات الخطورة ────────────────────────────────────────────────────────
const SEVERITY = {
    INFO:     'info',
    WARN:     'warn',
    ERROR:    'error',
    CRITICAL: 'critical',
};

class RuntimeAnalyzer {

    constructor() {
        // activeAttempts: accountId → { attemptId, startedAt, connectionType }
        this._activeAttempts = new Map();
        // errorBuffer: accountId → [{ ts, error, context }] (آخر 50 خطأ في الذاكرة)
        this._errorBuffer = new Map();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  إدارة محاولات الاتصال
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * بدء تسجيل محاولة اتصال جديدة
     * @returns {string} attemptId
     */
    async startAttempt(accountId, connectionType = 'qr_code', reconnectNumber = 0) {
        try {
            // إنهاء أي محاولة نشطة سابقة للحساب
            await this._closeActiveAttempt(accountId, OUTCOMES.CANCELLED, 'replaced_by_new_attempt');

            const attemptId = crypto.randomUUID();
            const now = new Date();

            await query(`
                INSERT INTO connection_attempts
                    (id, account_id, connection_type, started_at, reconnect_attempt, outcome)
                VALUES ($1, $2, $3, $4, $5, 'in_progress')
            `, [attemptId, accountId, connectionType, now, reconnectNumber]);

            this._activeAttempts.set(accountId, {
                attemptId,
                startedAt:      now.getTime(),
                connectionType,
            });

            await this.logEvent(accountId, attemptId, EVENT_TYPES.STATE_CHANGE, 'initializing', {
                connectionType,
                reconnectAttempt: reconnectNumber,
            }, SEVERITY.INFO);

            return attemptId;
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] startAttempt error for ${accountId}:`, err.message);
            return null;
        }
    }

    /**
     * إنهاء المحاولة النشطة بنتيجة محددة
     */
    async endAttempt(accountId, outcome, failureStage = null, failureReason = null) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;

            const now       = new Date();
            const durationMs = now.getTime() - active.startedAt;

            await query(`
                UPDATE connection_attempts
                SET outcome = $1, ended_at = $2, duration_ms = $3,
                    failure_stage = $4, failure_reason = $5
                WHERE id = $6
            `, [outcome, now, durationMs, failureStage, failureReason, active.attemptId]);

            this._activeAttempts.delete(accountId);

            // تسجيل حدث الإنهاء
            const severity = outcome === OUTCOMES.CONNECTED ? SEVERITY.INFO : SEVERITY.ERROR;
            await this.logEvent(accountId, active.attemptId,
                outcome === OUTCOMES.CONNECTED ? EVENT_TYPES.CONNECTED : EVENT_TYPES.DISCONNECTED,
                failureStage || 'end',
                { outcome, durationMs, failureReason },
                severity
            );
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] endAttempt error for ${accountId}:`, err.message);
        }
    }

    /**
     * تسجيل حدث في timeline المحاولة الحالية
     */
    async logEvent(accountId, attemptId, eventType, stage, data = {}, severity = SEVERITY.INFO) {
        if (!attemptId) return;
        try {
            const active     = this._activeAttempts.get(accountId);
            const startedAt  = active?.startedAt || Date.now();
            const durationMs = Date.now() - startedAt;

            await query(`
                INSERT INTO connection_events
                    (id, account_id, attempt_id, event_type, stage,
                     event_data, severity, duration_from_start_ms)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                crypto.randomUUID(),
                accountId,
                attemptId,
                eventType,
                stage,
                JSON.stringify(data),
                severity,
                durationMs,
            ]);
        } catch (err) {
            // لا نريد أن يُعطل نظام التتبع تدفق الاتصال
            console.warn(`[RuntimeAnalyzer] logEvent error:`, err.message);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Hooks لـ WhatsAppManager (تُستدعى من داخله)
    // ══════════════════════════════════════════════════════════════════════════

    /** عند تغيير حالة الاتصال */
    async onStateChange(accountId, state, extra = {}) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;

            const severity = state === 'error' ? SEVERITY.ERROR
                           : state === 'disconnected' ? SEVERITY.WARN
                           : SEVERITY.INFO;

            await this.logEvent(accountId, active.attemptId, EVENT_TYPES.STATE_CHANGE, state, extra, severity);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onStateChange error:`, err.message);
        }
    }

    /** عند توليد QR Code */
    async onQRGenerated(accountId, qrTs) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;
            await this.logEvent(accountId, active.attemptId, EVENT_TYPES.QR_GENERATED, 'qr_ready', {
                generatedAt: new Date(qrTs).toISOString(),
            }, SEVERITY.INFO);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onQRGenerated error:`, err.message);
        }
    }

    /** عند إنشاء Pairing Code */
    async onPairingCode(accountId, phoneNumber) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;
            await this.logEvent(accountId, active.attemptId, EVENT_TYPES.PAIRING_CODE, 'pairing_ready', {
                phoneNumber: phoneNumber?.replace(/\d(?=\d{4})/g, '*'), // إخفاء جزء من الرقم
            }, SEVERITY.INFO);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onPairingCode error:`, err.message);
        }
    }

    /** عند وقوع خطأ */
    async onError(accountId, context, errorMessage, stage = 'unknown') {
        try {
            // تخزين مؤقت للأخطاء في الذاكرة لرصد الأنماط فوراً
            const buf = this._errorBuffer.get(accountId) || [];
            buf.push({ ts: Date.now(), context, error: errorMessage, stage });
            if (buf.length > 50) buf.shift();
            this._errorBuffer.set(accountId, buf);

            const active = this._activeAttempts.get(accountId);
            if (!active) return;

            await this.logEvent(accountId, active.attemptId, EVENT_TYPES.ERROR, stage, {
                context,
                error: errorMessage,
            }, SEVERITY.ERROR);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onError error:`, err.message);
        }
    }

    /** عند انقطاع الاتصال (Disconnect Code) */
    async onDisconnect(accountId, statusCode, stage = 'connecting') {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;

            const severity = [401, 440].includes(statusCode) ? SEVERITY.CRITICAL : SEVERITY.ERROR;

            await this.logEvent(accountId, active.attemptId, EVENT_TYPES.DISCONNECTED, stage, {
                statusCode,
                codeLabel: this._labelDisconnectCode(statusCode),
            }, severity);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onDisconnect error:`, err.message);
        }
    }

    /** عند محاولة إعادة الاتصال */
    async onReconnect(accountId, attempt, delayMs) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;
            await this.logEvent(accountId, active.attemptId, EVENT_TYPES.RECONNECT, 'reconnecting', {
                attempt,
                delayMs,
            }, SEVERITY.WARN);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onReconnect error:`, err.message);
        }
    }

    /** عند مسح الجلسة */
    async onSessionCleared(accountId, clearCode) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (active) {
                await this.logEvent(accountId, active.attemptId, EVENT_TYPES.SESSION_CLEARED, 'session_cleared', {
                    clearCode,
                }, SEVERITY.CRITICAL);
            }
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] onSessionCleared error:`, err.message);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تحليل البيانات — Runtime Analysis
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * جلب كامل timeline لمحاولة اتصال محددة
     */
    async getAttemptTimeline(attemptId) {
        try {
            const attempt = await queryOne(
                `SELECT * FROM connection_attempts WHERE id = $1`,
                [attemptId]
            );
            if (!attempt) return null;

            const events = await queryAll(
                `SELECT * FROM connection_events
                 WHERE attempt_id = $1
                 ORDER BY duration_from_start_ms ASC`,
                [attemptId]
            );

            // حساب المدة بين الأحداث
            const enrichedEvents = events.map((ev, i) => ({
                ...ev,
                event_data: this._parseJSON(ev.event_data),
                gapFromPrev: i === 0 ? 0 : ev.duration_from_start_ms - events[i - 1].duration_from_start_ms,
            }));

            return {
                attempt,
                events:    enrichedEvents,
                totalEvents: events.length,
                summary:   this._buildTimelineSummary(attempt, enrichedEvents),
            };
        } catch (err) {
            console.error(`[RuntimeAnalyzer] getAttemptTimeline error:`, err.message);
            return null;
        }
    }

    /**
     * جلب آخر N محاولة اتصال للحساب مع عدد أحداثها
     */
    async getRecentAttempts(accountId, limit = 10) {
        try {
            return await queryAll(`
                SELECT ca.*,
                       COUNT(ce.id)::int     AS event_count,
                       COUNT(CASE WHEN ce.severity = 'error'    THEN 1 END)::int AS error_count,
                       COUNT(CASE WHEN ce.severity = 'critical' THEN 1 END)::int AS critical_count
                FROM connection_attempts ca
                LEFT JOIN connection_events ce ON ce.attempt_id = ca.id
                WHERE ca.account_id = $1
                GROUP BY ca.id
                ORDER BY ca.started_at DESC
                LIMIT $2
            `, [accountId, limit]);
        } catch (err) {
            console.error(`[RuntimeAnalyzer] getRecentAttempts error:`, err.message);
            return [];
        }
    }

    /**
     * رصد الأخطاء المتكررة وتجميعها (Pattern Detection)
     */
    async getErrorPatterns(accountId, hours = 24) {
        try {
            const rows = await queryAll(`
                SELECT
                    ce.event_data,
                    ce.stage,
                    ce.severity,
                    COUNT(*) AS occurrences,
                    MAX(ce.created_at) AS last_seen,
                    MIN(ce.created_at) AS first_seen
                FROM connection_events ce
                JOIN connection_attempts ca ON ca.id = ce.attempt_id
                WHERE ca.account_id = $1
                  AND ce.event_type = 'error'
                  AND ce.created_at >= NOW() - ($2 || ' hours')::interval
                GROUP BY ce.event_data, ce.stage, ce.severity
                ORDER BY occurrences DESC
                LIMIT 20
            `, [accountId, hours]);

            // دمج الأخطاء المتشابهة بناءً على رسالة الخطأ
            const patterns = rows.map(r => {
                const data = this._parseJSON(r.event_data);
                return {
                    error:       data?.error || 'unknown',
                    context:     data?.context || r.stage,
                    stage:       r.stage,
                    severity:    r.severity,
                    occurrences: parseInt(r.occurrences),
                    lastSeen:    r.last_seen,
                    firstSeen:   r.first_seen,
                    isRecurring: parseInt(r.occurrences) >= 3,
                };
            });

            // إضافة الأخطاء الحديثة من الذاكرة
            const memBuf = this._errorBuffer.get(accountId) || [];
            const recentErrors = memBuf.slice(-5).map(e => ({
                error:       e.error,
                context:     e.context,
                stage:       e.stage,
                severity:    SEVERITY.ERROR,
                occurrences: 1,
                lastSeen:    new Date(e.ts).toISOString(),
                fromMemory:  true,
            }));

            return {
                patterns,
                recentFromMemory: recentErrors,
                totalPatterns:    patterns.length,
                hasRecurring:     patterns.some(p => p.isRecurring),
                mostFrequent:     patterns[0] || null,
                analysisWindow:   `${hours} ساعة`,
            };
        } catch (err) {
            console.error(`[RuntimeAnalyzer] getErrorPatterns error:`, err.message);
            return { patterns: [], recentFromMemory: [], totalPatterns: 0 };
        }
    }

    /**
     * إحصائيات الاتصال للحساب
     */
    async getConnectionStats(accountId, days = 7) {
        try {
            const stats = await queryOne(`
                SELECT
                    COUNT(*)::int                                                            AS total_attempts,
                    COUNT(CASE WHEN outcome = 'connected'  THEN 1 END)::int                 AS successful,
                    COUNT(CASE WHEN outcome != 'connected' AND outcome != 'in_progress' THEN 1 END)::int AS failed,
                    COUNT(CASE WHEN outcome = 'in_progress' THEN 1 END)::int                AS in_progress,
                    AVG(CASE WHEN outcome = 'connected' THEN duration_ms END)::int          AS avg_success_ms,
                    AVG(CASE WHEN outcome != 'connected' AND duration_ms IS NOT NULL THEN duration_ms END)::int AS avg_failure_ms,
                    MIN(CASE WHEN outcome = 'connected' THEN duration_ms END)::int          AS min_success_ms,
                    MAX(duration_ms)::int                                                   AS max_duration_ms,
                    COUNT(CASE WHEN connection_type = 'qr_code'     THEN 1 END)::int        AS qr_attempts,
                    COUNT(CASE WHEN connection_type = 'pairing_code' THEN 1 END)::int       AS pairing_attempts,
                    COUNT(CASE WHEN connection_type = 'reconnect'    THEN 1 END)::int       AS reconnect_attempts,
                    MAX(started_at)                                                         AS last_attempt_at
                FROM connection_attempts
                WHERE account_id = $1
                  AND started_at >= NOW() - ($2 || ' days')::interval
            `, [accountId, days]);

            const successRate = stats.total_attempts > 0
                ? Math.round((stats.successful / stats.total_attempts) * 100)
                : 0;

            // توزيع الفشل حسب المرحلة
            const failureByStage = await queryAll(`
                SELECT failure_stage, COUNT(*) AS count
                FROM connection_attempts
                WHERE account_id = $1
                  AND outcome NOT IN ('connected', 'in_progress', 'cancelled')
                  AND started_at >= NOW() - ($2 || ' days')::interval
                  AND failure_stage IS NOT NULL
                GROUP BY failure_stage
                ORDER BY count DESC
            `, [accountId, days]);

            // توزيع الفشل حسب السبب
            const failureByReason = await queryAll(`
                SELECT failure_reason, COUNT(*) AS count
                FROM connection_attempts
                WHERE account_id = $1
                  AND outcome NOT IN ('connected', 'in_progress', 'cancelled')
                  AND started_at >= NOW() - ($2 || ' days')::interval
                  AND failure_reason IS NOT NULL
                GROUP BY failure_reason
                ORDER BY count DESC
                LIMIT 5
            `, [accountId, days]);

            // اتجاه المحاولات يومياً
            const dailyTrend = await queryAll(`
                SELECT
                    DATE(started_at)::text                                            AS day,
                    COUNT(*)::int                                                     AS total,
                    COUNT(CASE WHEN outcome = 'connected' THEN 1 END)::int           AS success,
                    COUNT(CASE WHEN outcome NOT IN ('connected','in_progress','cancelled') THEN 1 END)::int AS failure
                FROM connection_attempts
                WHERE account_id = $1
                  AND started_at >= NOW() - ($2 || ' days')::interval
                GROUP BY DATE(started_at)
                ORDER BY day ASC
            `, [accountId, days]);

            return {
                summary: { ...stats, successRate },
                failureByStage,
                failureByReason,
                dailyTrend,
                analysisPeriod: `${days} أيام`,
            };
        } catch (err) {
            console.error(`[RuntimeAnalyzer] getConnectionStats error:`, err.message);
            return { summary: {}, failureByStage: [], failureByReason: [], dailyTrend: [] };
        }
    }

    /**
     * إحصائيات النظام بالكامل (Admin)
     */
    async getSystemRuntimeStats(hours = 24) {
        try {
            const overview = await queryOne(`
                SELECT
                    COUNT(DISTINCT account_id)::int                                     AS active_accounts,
                    COUNT(*)::int                                                        AS total_attempts,
                    COUNT(CASE WHEN outcome = 'connected'    THEN 1 END)::int           AS successful,
                    COUNT(CASE WHEN outcome = 'in_progress'  THEN 1 END)::int           AS in_progress,
                    COUNT(CASE WHEN outcome NOT IN ('connected','in_progress','cancelled') THEN 1 END)::int AS failed,
                    AVG(CASE WHEN outcome = 'connected' THEN duration_ms END)::int      AS avg_connect_ms,
                    COUNT(CASE WHEN outcome = 'failed'   THEN 1 END)::int               AS hard_failures
                FROM connection_attempts
                WHERE started_at >= NOW() - ($1 || ' hours')::interval
            `, [hours]);

            const topFailingAccounts = await queryAll(`
                SELECT account_id, COUNT(*) AS failures
                FROM connection_attempts
                WHERE outcome NOT IN ('connected','in_progress','cancelled')
                  AND started_at >= NOW() - ($1 || ' hours')::interval
                GROUP BY account_id
                ORDER BY failures DESC
                LIMIT 5
            `, [hours]);

            const errorRate = await queryAll(`
                SELECT
                    ce.event_type,
                    COUNT(*) AS count
                FROM connection_events ce
                WHERE ce.severity IN ('error','critical')
                  AND ce.created_at >= NOW() - ($1 || ' hours')::interval
                GROUP BY ce.event_type
                ORDER BY count DESC
            `, [hours]);

            return {
                overview,
                topFailingAccounts,
                errorRate,
                window: `${hours} ساعة`,
                generatedAt: new Date().toISOString(),
            };
        } catch (err) {
            console.error(`[RuntimeAnalyzer] getSystemRuntimeStats error:`, err.message);
            return { overview: {}, topFailingAccounts: [], errorRate: [] };
        }
    }

    /**
     * تقرير runtime كامل للحساب (للـ DiagnosticController)
     */
    async getFullRuntimeReport(accountId) {
        const [recentAttempts, errorPatterns, connStats, activeAttempt] = await Promise.all([
            this.getRecentAttempts(accountId, 5),
            this.getErrorPatterns(accountId, 48),
            this.getConnectionStats(accountId, 7),
            Promise.resolve(this._activeAttempts.get(accountId) || null),
        ]);

        // جلب timeline آخر محاولة
        let lastTimeline = null;
        if (recentAttempts.length > 0) {
            lastTimeline = await this.getAttemptTimeline(recentAttempts[0].id);
        }

        return {
            accountId,
            generatedAt:    new Date().toISOString(),
            activeAttempt:  activeAttempt ? {
                attemptId:      activeAttempt.attemptId,
                startedAt:      new Date(activeAttempt.startedAt).toISOString(),
                connectionType: activeAttempt.connectionType,
                runningForMs:   Date.now() - activeAttempt.startedAt,
            } : null,
            recentAttempts,
            lastTimeline,
            errorPatterns,
            connectionStats: connStats,
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  Helper Methods
    // ══════════════════════════════════════════════════════════════════════════

    async _closeActiveAttempt(accountId, outcome, reason) {
        try {
            const active = this._activeAttempts.get(accountId);
            if (!active) return;

            const durationMs = Date.now() - active.startedAt;
            await query(`
                UPDATE connection_attempts
                SET outcome = $1, ended_at = NOW(), duration_ms = $2, failure_reason = $3
                WHERE id = $4 AND outcome = 'in_progress'
            `, [outcome, durationMs, reason, active.attemptId]);

            this._activeAttempts.delete(accountId);
        } catch (err) {
            console.warn(`[RuntimeAnalyzer] _closeActiveAttempt error:`, err.message);
        }
    }

    _buildTimelineSummary(attempt, events) {
        const stateChanges = events.filter(e => e.event_type === EVENT_TYPES.STATE_CHANGE);
        const errors       = events.filter(e => e.event_type === EVENT_TYPES.ERROR);
        const lastStage    = stateChanges[stateChanges.length - 1]?.stage || 'unknown';

        return {
            connectionType: attempt.connection_type,
            outcome:        attempt.outcome,
            durationMs:     attempt.duration_ms,
            stagesVisited:  stateChanges.map(e => e.stage),
            lastStage,
            totalErrors:    errors.length,
            criticalEvents: events.filter(e => e.severity === SEVERITY.CRITICAL).length,
            failedAt:       attempt.failure_stage,
            failureReason:  attempt.failure_reason,
        };
    }

    _labelDisconnectCode(code) {
        const labels = {
            401: 'loggedOut',
            440: 'connectionReplaced',
            500: 'badSession',
            515: 'restartRequired',
            408: 'connectionLost/timedOut',
            428: 'connectionClosed',
        };
        return labels[code] || `unknown(${code})`;
    }

    _parseJSON(str) {
        if (!str) return {};
        if (typeof str === 'object') return str;
        try { return JSON.parse(str); } catch { return { raw: str }; }
    }

    getEventTypes()  { return EVENT_TYPES; }
    getOutcomes()    { return OUTCOMES; }
}

module.exports = new RuntimeAnalyzer();
