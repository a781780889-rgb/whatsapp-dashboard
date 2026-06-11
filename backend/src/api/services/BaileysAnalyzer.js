'use strict';
/**
 * BaileysAnalyzer.js — المرحلة التاسعة: تحليل Baileys المتعمق
 *
 * مهام هذه الوحدة:
 *   1. تتبع أحداث Baileys الداخلية (socket events, creds.update, messages.upsert...)
 *   2. قياس زمن معالجة كل نوع من الأحداث
 *   3. تحليل تدفق الرسائل: الإرسال، التسليم، القراءة، الأخطاء
 *   4. رصد أنماط الأخطاء والتقطعات المتكررة
 *   5. تقارير: per-account + system-wide
 *
 * مصادر البيانات:
 *   - جدول baileys_event_log   (جديد — أحداث Baileys الداخلية)
 *   - جدول baileys_message_flow (جديد — تدفق الرسائل)
 *   - جدول connection_attempts  (للربط بالمحاولة)
 *   - جدول connection_events    (للأحداث التاريخية)
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const crypto = require('crypto');

// ── فئات الأحداث ──────────────────────────────────────────────────────────
const EVENT_CATEGORIES = {
    CONNECTION: 'connection',       // connection.update, creds.update
    MESSAGES:   'messages',         // messages.upsert, messages.update
    CHATS:      'chats',            // chats.upsert, chats.update
    CONTACTS:   'contacts',         // contacts.upsert, contacts.update
    PRESENCE:   'presence',         // presence.update
    GROUPS:     'groups',           // groups.upsert, groups.update
    HISTORY:    'history',          // messaging-history.set
    CALL:       'call',             // call events
};

// ── مستويات الخطورة ───────────────────────────────────────────────────────
const SEVERITY = {
    INFO:     'info',
    WARNING:  'warning',
    ERROR:    'error',
    CRITICAL: 'critical',
};

// ── حدود التحذير ──────────────────────────────────────────────────────────
const THRESHOLDS = {
    EVENT_PROC_WARN_MS:     500,    // > 500ms معالجة حدث → تحذير
    EVENT_PROC_CRITICAL_MS: 2000,   // > 2 ث معالجة حدث → حرج
    MSG_SEND_WARN_MS:       5000,   // > 5 ث إرسال → بطيء
    MSG_DELIVERY_WARN_MS:   30_000, // > 30 ث تسليم → بطيء
    HIGH_ERROR_RATE:        20,     // > 20% أخطاء → مشكلة
    HIGH_RETRY_RATE:        30,     // > 30% إعادة محاولة → مشكلة
    HISTORY_LIMIT:          100,
};

// ─────────────────────────────────────────────────────────────────────────────

class BaileysAnalyzer {

    constructor() {
        // تتبع وقت بدء معالجة الأحداث: accountId+eventName → timestamp
        this._eventStartTimes = new Map();
        // تتبع الرسائل المرسلة: messageId → { accountId, sentAt, logId }
        this._pendingMessages = new Map();
        // آخر نشاط لكل حساب
        this._lastActivity = new Map();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  HOOKS — يُستدعى من WhatsAppManager.js
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * يُستدعى عند بدء معالجة أي حدث Baileys
     */
    async onEventStart(accountId, eventCategory, eventName, attemptId = null) {
        const key = `${accountId}:${eventName}:${Date.now()}`;
        this._eventStartTimes.set(key, { startAt: Date.now(), category: eventCategory, name: eventName, attemptId });
        this._lastActivity.set(accountId, Date.now());
        return key; // يُعاد للمستدعي لاستخدامه في onEventEnd
    }

    /**
     * يُستدعى عند انتهاء معالجة الحدث
     */
    async onEventEnd(accountId, eventKey, eventData = null, error = null) {
        const startInfo = this._eventStartTimes.get(eventKey);
        if (!startInfo) return;
        this._eventStartTimes.delete(eventKey);

        const processingTime = Date.now() - startInfo.startAt;
        const severity = error
            ? (processingTime > THRESHOLDS.EVENT_PROC_CRITICAL_MS ? SEVERITY.CRITICAL : SEVERITY.ERROR)
            : (processingTime > THRESHOLDS.EVENT_PROC_CRITICAL_MS
                ? SEVERITY.CRITICAL
                : processingTime > THRESHOLDS.EVENT_PROC_WARN_MS
                    ? SEVERITY.WARNING
                    : SEVERITY.INFO);

        try {
            await query(`
                INSERT INTO baileys_event_log
                    (id, account_id, attempt_id, event_category, event_name, event_data, processing_time_ms, error_message, severity)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            `, [
                crypto.randomUUID(),
                accountId,
                startInfo.attemptId,
                startInfo.category,
                startInfo.name,
                eventData ? JSON.stringify(eventData) : null,
                processingTime,
                error || null,
                severity,
            ]);
        } catch (err) {
            console.error('[BaileysAnalyzer] onEventEnd:', err.message);
        }
    }

    /**
     * يُستدعى عند إرسال رسالة
     */
    async onMessageSent(accountId, messageId, jid, attemptId = null) {
        if (!messageId) return;
        try {
            const result = await query(`
                INSERT INTO baileys_message_flow
                    (id, account_id, message_id, jid, direction, status)
                VALUES ($1,$2,$3,$4,'outbound','sent')
                RETURNING id
            `, [crypto.randomUUID(), accountId, messageId, jid]);

            const logId = result?.rows?.[0]?.id;
            if (logId) {
                this._pendingMessages.set(messageId, { accountId, sentAt: Date.now(), logId });
            }
        } catch (err) {
            console.error('[BaileysAnalyzer] onMessageSent:', err.message);
        }
    }

    /**
     * يُستدعى عند تحديث حالة الرسالة (delivered / read / error)
     */
    async onMessageStatusUpdate(accountId, messageId, newStatus, errorCode = null, errorMsg = null) {
        const pending = this._pendingMessages.get(messageId);
        const now = Date.now();

        try {
            if (pending) {
                const sendDelay = now - pending.sentAt;
                const isDelivered = ['delivered', 'read'].includes(newStatus);
                const isRead      = newStatus === 'read';

                await query(`
                    UPDATE baileys_message_flow
                    SET status = $1,
                        delivery_delay_ms = CASE WHEN $2 THEN $3 ELSE delivery_delay_ms END,
                        read_delay_ms     = CASE WHEN $4 THEN $3 ELSE read_delay_ms     END,
                        error_code        = COALESCE($5, error_code),
                        error_message     = COALESCE($6, error_message)
                    WHERE id = $7
                `, [newStatus, isDelivered, sendDelay, isRead, errorCode, errorMsg, pending.logId]);

                if (['delivered', 'read', 'error', 'failed'].includes(newStatus)) {
                    this._pendingMessages.delete(messageId);
                }
            } else {
                // رسالة واردة أو لا يوجد سجل
                await query(`
                    INSERT INTO baileys_message_flow
                        (id, account_id, message_id, direction, status, error_code, error_message)
                    VALUES ($1,$2,$3,'inbound',$4,$5,$6)
                    ON CONFLICT DO NOTHING
                `, [crypto.randomUUID(), accountId, messageId, newStatus, errorCode, errorMsg]);
            }
        } catch (err) {
            console.error('[BaileysAnalyzer] onMessageStatusUpdate:', err.message);
        }
    }

    /**
     * يُستدعى عند فشل إرسال رسالة
     */
    async onMessageError(accountId, messageId, errorCode, errorMsg, retryCount = 0) {
        const pending = this._pendingMessages.get(messageId);
        try {
            if (pending) {
                await query(`
                    UPDATE baileys_message_flow
                    SET status='error', error_code=$1, error_message=$2, retry_count=$3
                    WHERE id=$4
                `, [errorCode, errorMsg, retryCount, pending.logId]);
                if (retryCount === 0) this._pendingMessages.delete(messageId);
            }
        } catch (err) {
            console.error('[BaileysAnalyzer] onMessageError:', err.message);
        }
    }

    /**
     * يُستدعى عند تسجيل حدث اتصال مهم (connection.update)
     */
    async onConnectionEvent(accountId, eventName, data = {}, attemptId = null) {
        const severity = data.isOnline === false ? SEVERITY.WARNING
            : data.connection === 'close'        ? SEVERITY.ERROR
            : SEVERITY.INFO;
        try {
            await query(`
                INSERT INTO baileys_event_log
                    (id, account_id, attempt_id, event_category, event_name, event_data, severity)
                VALUES ($1,$2,$3,$4,$5,$6,$7)
            `, [
                crypto.randomUUID(), accountId, attemptId,
                EVENT_CATEGORIES.CONNECTION, eventName,
                JSON.stringify(data), severity,
            ]);
        } catch (err) {
            console.error('[BaileysAnalyzer] onConnectionEvent:', err.message);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  ANALYSIS — Per-Account
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * تقرير شامل لحساب واحد
     */
    async generateAccountReport(accountId) {
        const startTime = Date.now();

        const [stats, eventBreakdown, msgStats, recentErrors, slowEvents, latencyTrend] = await Promise.all([
            this.getAccountStats(accountId),
            this._getEventCategoryBreakdown(accountId),
            this._getMessageFlowStats(accountId),
            this._getRecentErrors(accountId),
            this._getSlowEvents(accountId),
            this._getEventLatencyTrend(accountId),
        ]);

        const issues = this._detectAccountIssues(stats, msgStats);

        return {
            accountId,
            status: issues.some(i => i.severity === 'critical') ? 'critical'
                  : issues.some(i => i.severity === 'warning')  ? 'warning' : 'healthy',
            issues,
            stats,
            eventBreakdown,
            messageFlow: msgStats,
            recentErrors,
            slowEvents,
            latencyTrend,
            analyzedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
        };
    }

    /**
     * إحصائيات مختصرة لحساب
     */
    async getAccountStats(accountId) {
        const [evtRow, msgRow, errRow] = await Promise.all([
            queryOne(`
                SELECT
                    COUNT(*) AS total_events,
                    COUNT(*) FILTER (WHERE severity='error')    AS error_events,
                    COUNT(*) FILTER (WHERE severity='critical') AS critical_events,
                    COUNT(*) FILTER (WHERE severity='warning')  AS warning_events,
                    AVG(processing_time_ms) AS avg_proc_ms,
                    MAX(processing_time_ms) AS max_proc_ms,
                    MAX(created_at)         AS last_event_at
                FROM baileys_event_log
                WHERE account_id=$1
            `, [accountId]),

            queryOne(`
                SELECT
                    COUNT(*) AS total_messages,
                    COUNT(*) FILTER (WHERE direction='outbound') AS sent,
                    COUNT(*) FILTER (WHERE direction='inbound')  AS received,
                    COUNT(*) FILTER (WHERE status='delivered')   AS delivered,
                    COUNT(*) FILTER (WHERE status='read')        AS read_count,
                    COUNT(*) FILTER (WHERE status='error')       AS errors,
                    COUNT(*) FILTER (WHERE retry_count > 0)      AS retried,
                    AVG(delivery_delay_ms) AS avg_delivery_ms,
                    AVG(read_delay_ms)     AS avg_read_ms
                FROM baileys_message_flow
                WHERE account_id=$1
            `, [accountId]),

            queryOne(`
                SELECT COUNT(*) AS total
                FROM baileys_event_log
                WHERE account_id=$1 AND severity IN ('error','critical')
                  AND created_at > NOW() - INTERVAL '1 hour'
            `, [accountId]),
        ]);

        const total = parseInt(evtRow?.total_events || 0);
        const errCount = parseInt(evtRow?.error_events || 0) + parseInt(evtRow?.critical_events || 0);
        const msgTotal = parseInt(msgRow?.total_messages || 0);
        const msgErr   = parseInt(msgRow?.errors || 0);

        return {
            totalEvents:      total,
            errorEvents:      errCount,
            criticalEvents:   parseInt(evtRow?.critical_events || 0),
            warningEvents:    parseInt(evtRow?.warning_events || 0),
            errorRate:        total ? Math.round(errCount / total * 100) : 0,
            avgProcMs:        Math.round(parseFloat(evtRow?.avg_proc_ms || 0)),
            maxProcMs:        parseInt(evtRow?.max_proc_ms || 0),
            lastEventAt:      evtRow?.last_event_at || null,
            recentErrors1h:   parseInt(errRow?.total || 0),

            totalMessages:    msgTotal,
            sentMessages:     parseInt(msgRow?.sent || 0),
            receivedMessages: parseInt(msgRow?.received || 0),
            deliveredMessages:parseInt(msgRow?.delivered || 0),
            readMessages:     parseInt(msgRow?.read_count || 0),
            messageErrors:    msgErr,
            retriedMessages:  parseInt(msgRow?.retried || 0),
            msgErrorRate:     msgTotal ? Math.round(msgErr / msgTotal * 100) : 0,
            avgDeliveryMs:    Math.round(parseFloat(msgRow?.avg_delivery_ms || 0)),
            avgReadMs:        Math.round(parseFloat(msgRow?.avg_read_ms || 0)),
        };
    }

    /**
     * تاريخ الأحداث الأخيرة لحساب
     */
    async getAccountHistory(accountId, limit = 50) {
        const rows = await queryAll(`
            SELECT id, event_category, event_name, processing_time_ms, severity, error_message, created_at
            FROM baileys_event_log
            WHERE account_id = $1
            ORDER BY created_at DESC
            LIMIT $2
        `, [accountId, Math.min(limit, THRESHOLDS.HISTORY_LIMIT)]);

        return rows || [];
    }

    /**
     * تحليل أخطاء الرسائل لحساب
     */
    async getMessageErrors(accountId, limit = 30) {
        const rows = await queryAll(`
            SELECT message_id, jid, status, error_code, error_message, retry_count,
                   delivery_delay_ms, created_at
            FROM baileys_message_flow
            WHERE account_id=$1 AND status IN ('error','failed')
            ORDER BY created_at DESC
            LIMIT $2
        `, [accountId, limit]);

        return rows || [];
    }

    /**
     * إحصائيات الأحداث حسب الفئة
     */
    async getEventBreakdown(accountId) {
        return this._getEventCategoryBreakdown(accountId);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  ANALYSIS — System-Wide (Admin)
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * تقرير النظام الشامل
     */
    async generateSystemReport() {
        const startTime = Date.now();

        const [sysStats, problematic, topErrors, recentCritical] = await Promise.all([
            this.getSystemStats(),
            this.getProblematicAccounts(10),
            this._getTopErrors(),
            this._getRecentCriticalEvents(20),
        ]);

        return {
            system: sysStats,
            problematicAccounts: problematic,
            topErrors,
            recentCriticalEvents: recentCritical,
            generatedAt: new Date().toISOString(),
            durationMs: Date.now() - startTime,
        };
    }

    /**
     * إحصائيات إجمالية للنظام
     */
    async getSystemStats() {
        const [evtRow, msgRow, acctRow] = await Promise.all([
            queryOne(`
                SELECT
                    COUNT(*)                                    AS total_events,
                    COUNT(*) FILTER (WHERE severity='error')    AS error_events,
                    COUNT(*) FILTER (WHERE severity='critical') AS critical_events,
                    COUNT(*) FILTER (WHERE severity='warning')  AS warning_events,
                    AVG(processing_time_ms)                     AS avg_proc_ms,
                    MAX(processing_time_ms)                     AS max_proc_ms,
                    COUNT(DISTINCT account_id)                  AS active_accounts
                FROM baileys_event_log
                WHERE created_at > NOW() - INTERVAL '24 hours'
            `),

            queryOne(`
                SELECT
                    COUNT(*)                                  AS total_messages,
                    COUNT(*) FILTER (WHERE status='error')   AS errors,
                    COUNT(*) FILTER (WHERE retry_count > 0)  AS retried,
                    AVG(delivery_delay_ms)                   AS avg_delivery_ms
                FROM baileys_message_flow
                WHERE created_at > NOW() - INTERVAL '24 hours'
            `),

            queryOne(`
                SELECT COUNT(DISTINCT account_id) AS total
                FROM baileys_event_log
                WHERE created_at > NOW() - INTERVAL '7 days'
            `),
        ]);

        const total  = parseInt(evtRow?.total_events || 0);
        const errors = parseInt(evtRow?.error_events || 0) + parseInt(evtRow?.critical_events || 0);

        return {
            last24h: {
                totalEvents:    total,
                errorEvents:    errors,
                criticalEvents: parseInt(evtRow?.critical_events || 0),
                warningEvents:  parseInt(evtRow?.warning_events || 0),
                errorRate:      total ? Math.round(errors / total * 100) : 0,
                avgProcMs:      Math.round(parseFloat(evtRow?.avg_proc_ms || 0)),
                maxProcMs:      parseInt(evtRow?.max_proc_ms || 0),
                activeAccounts: parseInt(evtRow?.active_accounts || 0),
                totalMessages:  parseInt(msgRow?.total_messages || 0),
                messageErrors:  parseInt(msgRow?.errors || 0),
                retriedMessages:parseInt(msgRow?.retried || 0),
                avgDeliveryMs:  Math.round(parseFloat(msgRow?.avg_delivery_ms || 0)),
            },
            totalActiveAccounts7d: parseInt(acctRow?.total || 0),
        };
    }

    /**
     * الحسابات الإشكالية (معدل خطأ مرتفع أو بطء)
     */
    async getProblematicAccounts(limit = 20) {
        const rows = await queryAll(`
            SELECT
                account_id,
                COUNT(*)                                    AS total_events,
                COUNT(*) FILTER (WHERE severity='error')    AS error_events,
                COUNT(*) FILTER (WHERE severity='critical') AS critical_events,
                AVG(processing_time_ms)                     AS avg_proc_ms,
                MAX(processing_time_ms)                     AS max_proc_ms,
                MAX(created_at)                             AS last_event_at
            FROM baileys_event_log
            WHERE created_at > NOW() - INTERVAL '24 hours'
            GROUP BY account_id
            HAVING COUNT(*) > 5
            ORDER BY (COUNT(*) FILTER (WHERE severity IN ('error','critical'))::float / NULLIF(COUNT(*),0)) DESC,
                     AVG(processing_time_ms) DESC
            LIMIT $1
        `, [limit]);

        return (rows || []).map(r => {
            const total = parseInt(r.total_events);
            const errs  = parseInt(r.error_events) + parseInt(r.critical_events);
            return {
                accountId:       r.account_id,
                totalEvents:     total,
                errorEvents:     errs,
                errorRate:       total ? Math.round(errs / total * 100) : 0,
                avgProcMs:       Math.round(parseFloat(r.avg_proc_ms || 0)),
                maxProcMs:       parseInt(r.max_proc_ms || 0),
                lastEventAt:     r.last_event_at,
            };
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  PRIVATE HELPERS
    // ══════════════════════════════════════════════════════════════════════════

    async _getEventCategoryBreakdown(accountId) {
        const rows = await queryAll(`
            SELECT
                event_category,
                event_name,
                COUNT(*)                  AS total,
                AVG(processing_time_ms)   AS avg_ms,
                MAX(processing_time_ms)   AS max_ms,
                COUNT(*) FILTER (WHERE severity IN ('error','critical')) AS errors
            FROM baileys_event_log
            WHERE account_id=$1
            GROUP BY event_category, event_name
            ORDER BY total DESC
            LIMIT 30
        `, [accountId]);

        return (rows || []).map(r => ({
            category: r.event_category,
            eventName: r.event_name,
            total:    parseInt(r.total),
            avgMs:    Math.round(parseFloat(r.avg_ms || 0)),
            maxMs:    parseInt(r.max_ms || 0),
            errors:   parseInt(r.errors || 0),
        }));
    }

    async _getMessageFlowStats(accountId) {
        const rows = await queryAll(`
            SELECT
                status,
                COUNT(*)              AS count,
                AVG(delivery_delay_ms) AS avg_delivery_ms,
                AVG(read_delay_ms)     AS avg_read_ms,
                AVG(retry_count)       AS avg_retries
            FROM baileys_message_flow
            WHERE account_id=$1
            GROUP BY status
        `, [accountId]);

        const result = {};
        for (const r of (rows || [])) {
            result[r.status] = {
                count:         parseInt(r.count),
                avgDeliveryMs: Math.round(parseFloat(r.avg_delivery_ms || 0)),
                avgReadMs:     Math.round(parseFloat(r.avg_read_ms || 0)),
                avgRetries:    parseFloat(r.avg_retries || 0).toFixed(2),
            };
        }
        return result;
    }

    async _getRecentErrors(accountId, limit = 10) {
        const rows = await queryAll(`
            SELECT event_name, error_message, severity, processing_time_ms, created_at
            FROM baileys_event_log
            WHERE account_id=$1 AND severity IN ('error','critical')
            ORDER BY created_at DESC
            LIMIT $2
        `, [accountId, limit]);
        return rows || [];
    }

    async _getSlowEvents(accountId, limit = 10) {
        const rows = await queryAll(`
            SELECT event_name, event_category, processing_time_ms, severity, created_at
            FROM baileys_event_log
            WHERE account_id=$1 AND processing_time_ms > $2
            ORDER BY processing_time_ms DESC
            LIMIT $3
        `, [accountId, THRESHOLDS.EVENT_PROC_WARN_MS, limit]);
        return rows || [];
    }

    async _getEventLatencyTrend(accountId, points = 10) {
        const rows = await queryAll(`
            SELECT
                DATE_TRUNC('hour', created_at) AS hour,
                AVG(processing_time_ms)         AS avg_ms,
                COUNT(*)                        AS count,
                COUNT(*) FILTER (WHERE severity IN ('error','critical')) AS errors
            FROM baileys_event_log
            WHERE account_id=$1 AND created_at > NOW() - INTERVAL '12 hours'
            GROUP BY 1
            ORDER BY 1 DESC
            LIMIT $2
        `, [accountId, points]);

        return (rows || []).reverse().map(r => ({
            hour:    r.hour,
            avgMs:   Math.round(parseFloat(r.avg_ms || 0)),
            count:   parseInt(r.count),
            errors:  parseInt(r.errors),
        }));
    }

    async _getTopErrors() {
        const rows = await queryAll(`
            SELECT
                event_name,
                error_message,
                COUNT(*) AS occurrences,
                COUNT(DISTINCT account_id) AS affected_accounts,
                MAX(created_at) AS last_seen
            FROM baileys_event_log
            WHERE severity IN ('error','critical')
              AND created_at > NOW() - INTERVAL '24 hours'
            GROUP BY event_name, error_message
            ORDER BY occurrences DESC
            LIMIT 15
        `);

        return (rows || []).map(r => ({
            eventName:        r.event_name,
            errorMessage:     r.error_message,
            occurrences:      parseInt(r.occurrences),
            affectedAccounts: parseInt(r.affected_accounts),
            lastSeen:         r.last_seen,
        }));
    }

    async _getRecentCriticalEvents(limit = 20) {
        const rows = await queryAll(`
            SELECT account_id, event_category, event_name, error_message, processing_time_ms, created_at
            FROM baileys_event_log
            WHERE severity='critical'
              AND created_at > NOW() - INTERVAL '6 hours'
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);
        return rows || [];
    }

    _detectAccountIssues(stats, msgStats) {
        const issues = [];

        if (stats.errorRate > THRESHOLDS.HIGH_ERROR_RATE) {
            issues.push({
                code:     'HIGH_BAILEYS_ERROR_RATE',
                severity: stats.errorRate > 40 ? 'critical' : 'warning',
                message:  `معدل أخطاء Baileys مرتفع: ${stats.errorRate}% (> ${THRESHOLDS.HIGH_ERROR_RATE}%)`,
                value:    stats.errorRate,
            });
        }

        if (stats.avgProcMs > THRESHOLDS.EVENT_PROC_CRITICAL_MS) {
            issues.push({
                code:     'BAILEYS_EVENT_PROC_CRITICAL',
                severity: 'critical',
                message:  `متوسط معالجة أحداث Baileys حرج: ${stats.avgProcMs}ms (> ${THRESHOLDS.EVENT_PROC_CRITICAL_MS}ms)`,
                value:    stats.avgProcMs,
            });
        } else if (stats.avgProcMs > THRESHOLDS.EVENT_PROC_WARN_MS) {
            issues.push({
                code:     'BAILEYS_EVENT_PROC_SLOW',
                severity: 'warning',
                message:  `متوسط معالجة أحداث Baileys بطيء: ${stats.avgProcMs}ms (> ${THRESHOLDS.EVENT_PROC_WARN_MS}ms)`,
                value:    stats.avgProcMs,
            });
        }

        if (stats.msgErrorRate > THRESHOLDS.HIGH_ERROR_RATE) {
            issues.push({
                code:     'HIGH_MESSAGE_ERROR_RATE',
                severity: stats.msgErrorRate > 40 ? 'critical' : 'warning',
                message:  `معدل أخطاء الرسائل مرتفع: ${stats.msgErrorRate}% (> ${THRESHOLDS.HIGH_ERROR_RATE}%)`,
                value:    stats.msgErrorRate,
            });
        }

        if (stats.recentErrors1h > 10) {
            issues.push({
                code:     'HIGH_RECENT_ERRORS',
                severity: stats.recentErrors1h > 30 ? 'critical' : 'warning',
                message:  `${stats.recentErrors1h} خطأ في آخر ساعة`,
                value:    stats.recentErrors1h,
            });
        }

        if (stats.avgDeliveryMs > THRESHOLDS.MSG_DELIVERY_WARN_MS) {
            issues.push({
                code:     'SLOW_MESSAGE_DELIVERY',
                severity: 'warning',
                message:  `متوسط تسليم الرسائل بطيء: ${Math.round(stats.avgDeliveryMs / 1000)} ث`,
                value:    stats.avgDeliveryMs,
            });
        }

        return issues;
    }
}

module.exports = new BaileysAnalyzer();
