'use strict';
/**
 * PairingCodeAnalyzer.js — المرحلة الثامنة: تحليل Pairing Code
 *
 * مهام هذه الوحدة:
 *   1. تتبع كل عملية Pairing Code: وقت البدء، توليد الكود، إدخاله، النتيجة
 *   2. قياس أزمنة التأخير الثلاثة:
 *        - request_delay_ms  : من اعتراض حدث QR حتى استقبال الكود من WhatsApp
 *        - display_delay_ms  : من pairing_starting حتى عرض الكود للمستخدم (الإجمالي)
 *        - entry_delay_ms    : من عرض الكود حتى إدخاله من المستخدم
 *   3. رصد الأخطاء: timeout (45 ث)، رفض الخادم، إدخال خاطئ، إلغاء
 *   4. كشف الحسابات ذات الـ Pairing البطيء أو المنخفض النجاح
 *   5. تقارير: per-account + system-wide
 *
 * مصادر البيانات:
 *   - جدول pairing_code_log  (جديد — تفاصيل كل عملية Pairing)
 *   - جدول connection_attempts  (للربط بالمحاولة الكاملة)
 *
 * دورة الحياة الكاملة:
 *   pairing_starting → [QR intercepted] → pairing_generating
 *   → requestPairingCode() → pairing_ready → (user enters code)
 *   → connecting → connected  ✅
 *
 * الـ Outcomes الممكنة:
 *   pending    → الكود عُرض وبانتظار الإدخال
 *   entered    → المستخدم أدخل الكود (restartRequired)
 *   connected  → الاتصال نجح بعد الإدخال
 *   timeout    → مهلة 45 ث انتهت قبل توليد الكود
 *   error      → requestPairingCode رمى خطأً
 *   cancelled  → ألغيت الجلسة قبل الاتصال
 *   failed     → أُدخل الكود لكن الاتصال فشل نهائياً
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const crypto = require('crypto');

// ── حدود التحذير ──────────────────────────────────────────────────────────
const THRESHOLDS = {
    REQUEST_DELAY_WARN_MS:     10_000,  // > 10 ث لتوليد الكود → تحذير
    REQUEST_DELAY_CRITICAL_MS: 25_000,  // > 25 ث لتوليد الكود → حرج
    DISPLAY_DELAY_WARN_MS:     15_000,  // > 15 ث من البدء لعرض الكود → تحذير
    DISPLAY_DELAY_CRITICAL_MS: 35_000,  // > 35 ث من البدء لعرض الكود → حرج
    ENTRY_DELAY_WARN_MS:      120_000,  // > 2 دقيقة لإدخال الكود → تحذير
    LOW_SUCCESS_RATE:              50,  // < 50% نجاح → مشكلة
    HIGH_TIMEOUT_RATE:             30,  // > 30% timeout → مشكلة
    HIGH_ERROR_RATE:               20,  // > 20% أخطاء خادم → مشكلة
    HISTORY_LIMIT:                 50,
};

// ── نتائج Pairing ──────────────────────────────────────────────────────────
const PAIRING_OUTCOMES = {
    PENDING:   'pending',
    ENTERED:   'entered',    // أدخل المستخدم الكود (restartRequired)
    CONNECTED: 'connected',  // اتصال ناجح
    TIMEOUT:   'timeout',    // مهلة 45 ث قبل توليد الكود
    ERROR:     'error',      // requestPairingCode رمى خطأ
    CANCELLED: 'cancelled',  // إلغاء الجلسة
    FAILED:    'failed',     // فشل نهائي بعد الإدخال
};

// ═══════════════════════════════════════════════════════════════════════════

class PairingCodeAnalyzer {

    constructor() {
        // تتبع عملية Pairing النشطة: accountId → { logId, startedAt, codeReadyAt, attemptId, phoneNumber }
        this._active     = new Map();
        // وقت بدء مرحلة pairing_starting: accountId → timestamp
        this._startingAt = new Map();
        // وقت بدء طلب الكود (QR intercepted): accountId → timestamp
        this._requestAt  = new Map();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Hooks — تُستدعى من WhatsAppManager
    // ══════════════════════════════════════════════════════════════════════

    /**
     * عند الدخول في حالة pairing_starting
     * @param {string} accountId
     * @param {string} phoneNumber
     */
    async onPairingStarting(accountId, phoneNumber) {
        try {
            // إنهاء أي عملية سابقة معلقة
            await this._closeActive(accountId, PAIRING_OUTCOMES.CANCELLED);

            this._startingAt.set(accountId, Date.now());

            // إنشاء سجل مبكر بـ outcome=pending
            const logId     = crypto.randomUUID();
            const attemptId = await this._getCurrentAttemptId(accountId);

            await query(`
                INSERT INTO pairing_code_log
                    (id, account_id, attempt_id, phone_number, outcome, created_at)
                VALUES ($1, $2, $3, $4, 'pending', NOW())
            `, [logId, accountId, attemptId, phoneNumber]);

            this._active.set(accountId, {
                logId,
                startedAt:    Date.now(),
                codeReadyAt:  null,
                attemptId,
                phoneNumber,
            });
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingStarting error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند اعتراض حدث QR واستدعاء requestPairingCode
     * (حالة pairing_generating)
     * @param {string} accountId
     */
    onPairingGenerating(accountId) {
        this._requestAt.set(accountId, Date.now());
    }

    /**
     * عند استقبال الكود من WhatsApp بنجاح
     * (حالة pairing_ready)
     * @param {string} accountId
     * @param {string} attemptId
     */
    async onPairingCodeReady(accountId, attemptId) {
        try {
            const now       = Date.now();
            const active    = this._active.get(accountId);
            const requestTs = this._requestAt.get(accountId);
            const startTs   = this._startingAt.get(accountId);

            const requestDelayMs = requestTs ? (now - requestTs) : null;
            const displayDelayMs = startTs   ? (now - startTs)   : null;

            if (active) {
                await query(`
                    UPDATE pairing_code_log
                    SET
                        attempt_id        = COALESCE($1, attempt_id),
                        request_delay_ms  = $2,
                        display_delay_ms  = $3,
                        code_ready_at     = NOW(),
                        outcome           = 'pending'
                    WHERE id = $4
                `, [attemptId || active.attemptId, requestDelayMs, displayDelayMs, active.logId]);

                this._active.set(accountId, {
                    ...active,
                    codeReadyAt: now,
                    attemptId:   attemptId || active.attemptId,
                });
            }
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingCodeReady error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند إدخال المستخدم للكود (restartRequired → يُعيد الاتصال)
     * @param {string} accountId
     */
    async onPairingEntered(accountId) {
        try {
            const active = this._active.get(accountId);
            if (!active) return;

            const entryDelayMs = active.codeReadyAt
                ? (Date.now() - active.codeReadyAt)
                : null;

            await query(`
                UPDATE pairing_code_log
                SET outcome = 'entered', entry_delay_ms = $1, entered_at = NOW()
                WHERE id = $2
            `, [entryDelayMs, active.logId]);

            // لا نحذف من _active هنا — ننتظر connected أو failed
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingEntered error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند الاتصال بنجاح
     * @param {string} accountId
     */
    async onPairingSuccess(accountId) {
        try {
            const active = this._active.get(accountId);
            if (!active) return;

            // إذا لم يُسجَّل entered → سجّله ضمنياً
            const entryDelayMs = active.codeReadyAt
                ? (Date.now() - active.codeReadyAt)
                : null;

            await query(`
                UPDATE pairing_code_log
                SET
                    outcome        = 'connected',
                    entered_at     = COALESCE(entered_at, NOW()),
                    entry_delay_ms = COALESCE(entry_delay_ms, $1),
                    connected_at   = NOW()
                WHERE id = $2
            `, [entryDelayMs, active.logId]);

            this._active.delete(accountId);
            this._startingAt.delete(accountId);
            this._requestAt.delete(accountId);
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingSuccess error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند انتهاء مهلة الـ 45 ثانية دون توليد الكود
     * @param {string} accountId
     */
    async onPairingTimeout(accountId) {
        try {
            const active = this._active.get(accountId);
            if (active) {
                await query(`
                    UPDATE pairing_code_log SET outcome = 'timeout' WHERE id = $1
                `, [active.logId]);
                this._active.delete(accountId);
            } else {
                // لم يبدأ التسجيل — أنشئ سجلاً مباشراً
                const logId     = crypto.randomUUID();
                const attemptId = await this._getCurrentAttemptId(accountId);
                await query(`
                    INSERT INTO pairing_code_log
                        (id, account_id, attempt_id, outcome, created_at)
                    VALUES ($1, $2, $3, 'timeout', NOW())
                `, [logId, accountId, attemptId]);
            }
            this._startingAt.delete(accountId);
            this._requestAt.delete(accountId);
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingTimeout error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند فشل requestPairingCode (خطأ من الخادم)
     * @param {string} accountId
     * @param {string} errorMessage
     */
    async onPairingError(accountId, errorMessage) {
        try {
            const active = this._active.get(accountId);
            if (active) {
                await query(`
                    UPDATE pairing_code_log
                    SET outcome = 'error', error_message = $1
                    WHERE id = $2
                `, [errorMessage?.substring(0, 500), active.logId]);
                this._active.delete(accountId);
            }
            this._startingAt.delete(accountId);
            this._requestAt.delete(accountId);
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingError error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند إلغاء العملية (مسح الجلسة أو forceReset)
     * @param {string} accountId
     */
    async onPairingCancelled(accountId) {
        await this._closeActive(accountId, PAIRING_OUTCOMES.CANCELLED);
        this._startingAt.delete(accountId);
        this._requestAt.delete(accountId);
    }

    /**
     * عند الفشل النهائي بعد إدخال الكود
     * @param {string} accountId
     */
    async onPairingFailed(accountId) {
        try {
            const active = this._active.get(accountId);
            if (!active) return;
            await query(`
                UPDATE pairing_code_log SET outcome = 'failed' WHERE id = $1
            `, [active.logId]);
            this._active.delete(accountId);
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] onPairingFailed error for ${accountId}:`, err.message);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  تحليل Per-Account
    // ══════════════════════════════════════════════════════════════════════

    /**
     * تقرير شامل لـ Pairing Code لحساب محدد
     */
    async generateAccountReport(accountId) {
        const startTs = Date.now();

        const [stats, history, latency, issues] = await Promise.all([
            this._getAccountStats(accountId),
            this._getAccountHistory(accountId, 20),
            this._getLatencyBreakdown(accountId),
            this._detectAccountIssues(accountId),
        ]);

        return {
            accountId,
            status:      this._deriveStatus(issues),
            issues,
            stats,
            latency,
            history,
            analyzedAt:  new Date().toISOString(),
            durationMs:  Date.now() - startTs,
        };
    }

    async getAccountStats(accountId) {
        return this._getAccountStats(accountId);
    }

    async getAccountHistory(accountId, limit = THRESHOLDS.HISTORY_LIMIT) {
        return this._getAccountHistory(accountId, limit);
    }

    async getLatencyBreakdown(accountId) {
        return this._getLatencyBreakdown(accountId);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  تحليل System-Wide
    // ══════════════════════════════════════════════════════════════════════

    async generateSystemReport() {
        const startTs = Date.now();

        const [stats, problematicAccounts, recentActivity] = await Promise.all([
            this._getSystemStats(),
            this._getProblematicAccounts(),
            this._getRecentSystemActivity(),
        ]);

        return {
            stats,
            problematicAccounts,
            recentActivity,
            generatedAt: new Date().toISOString(),
            durationMs:  Date.now() - startTs,
        };
    }

    async getSystemStats() {
        return this._getSystemStats();
    }

    async getProblematicAccounts(limit = 20) {
        return this._getProblematicAccounts(limit);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  الدوال الداخلية
    // ══════════════════════════════════════════════════════════════════════

    async _getAccountStats(accountId) {
        const row = await queryOne(`
            SELECT
                COUNT(*)                                                          AS total,
                COUNT(*) FILTER (WHERE outcome = 'connected')                    AS connected,
                COUNT(*) FILTER (WHERE outcome = 'entered')                      AS entered,
                COUNT(*) FILTER (WHERE outcome = 'timeout')                      AS timeout_count,
                COUNT(*) FILTER (WHERE outcome = 'error')                        AS error_count,
                COUNT(*) FILTER (WHERE outcome = 'cancelled')                    AS cancelled,
                COUNT(*) FILTER (WHERE outcome = 'failed')                       AS failed,
                COUNT(*) FILTER (WHERE outcome = 'pending')                      AS pending,

                ROUND(AVG(request_delay_ms)  FILTER (WHERE request_delay_ms  IS NOT NULL))::int
                                                                                 AS avg_request_delay_ms,
                MAX(request_delay_ms)                                            AS max_request_delay_ms,
                MIN(request_delay_ms) FILTER (WHERE request_delay_ms > 0)       AS min_request_delay_ms,

                ROUND(AVG(display_delay_ms)  FILTER (WHERE display_delay_ms  IS NOT NULL))::int
                                                                                 AS avg_display_delay_ms,
                MAX(display_delay_ms)                                            AS max_display_delay_ms,

                ROUND(AVG(entry_delay_ms)    FILTER (WHERE entry_delay_ms    IS NOT NULL))::int
                                                                                 AS avg_entry_delay_ms,
                MAX(entry_delay_ms)                                              AS max_entry_delay_ms,

                MAX(created_at)                                                  AS last_attempt_at,
                MIN(created_at)                                                  AS first_attempt_at
            FROM pairing_code_log
            WHERE account_id = $1
        `, [accountId]);

        const total     = parseInt(row?.total       || 0);
        const connected = parseInt(row?.connected   || 0);
        const timeout   = parseInt(row?.timeout_count || 0);
        const errors    = parseInt(row?.error_count || 0);

        return {
            total,
            connected,
            entered:         parseInt(row?.entered    || 0),
            timeout,
            errors,
            cancelled:       parseInt(row?.cancelled  || 0),
            failed:          parseInt(row?.failed     || 0),
            pending:         parseInt(row?.pending    || 0),
            successRate:     total > 0 ? Math.round((connected / total) * 100) : null,
            timeoutRate:     total > 0 ? Math.round((timeout   / total) * 100) : null,
            errorRate:       total > 0 ? Math.round((errors    / total) * 100) : null,

            avgRequestDelayMs:  row?.avg_request_delay_ms || null,
            maxRequestDelayMs:  row?.max_request_delay_ms || null,
            minRequestDelayMs:  row?.min_request_delay_ms || null,

            avgDisplayDelayMs:  row?.avg_display_delay_ms || null,
            maxDisplayDelayMs:  row?.max_display_delay_ms || null,

            avgEntryDelayMs:    row?.avg_entry_delay_ms   || null,
            maxEntryDelayMs:    row?.max_entry_delay_ms   || null,

            lastAttemptAt:   row?.last_attempt_at  || null,
            firstAttemptAt:  row?.first_attempt_at || null,
        };
    }

    async _getAccountHistory(accountId, limit = 20) {
        const rows = await queryAll(`
            SELECT
                p.id,
                p.attempt_id,
                p.phone_number,
                p.request_delay_ms,
                p.display_delay_ms,
                p.entry_delay_ms,
                p.code_ready_at,
                p.entered_at,
                p.connected_at,
                p.outcome,
                p.error_message,
                p.created_at,
                a.reconnect_attempt
            FROM pairing_code_log p
            LEFT JOIN connection_attempts a ON a.id = p.attempt_id
            WHERE p.account_id = $1
            ORDER BY p.created_at DESC
            LIMIT $2
        `, [accountId, limit]);

        return rows.map(r => ({
            id:               r.id,
            attemptId:        r.attempt_id,
            phoneNumber:      r.phone_number,
            requestDelayMs:   r.request_delay_ms,
            displayDelayMs:   r.display_delay_ms,
            entryDelayMs:     r.entry_delay_ms,
            codeReadyAt:      r.code_ready_at,
            enteredAt:        r.entered_at,
            connectedAt:      r.connected_at,
            outcome:          r.outcome,
            errorMessage:     r.error_message,
            createdAt:        r.created_at,
            reconnectAttempt: r.reconnect_attempt,
            requestStatus:    this._classifyRequestDelay(r.request_delay_ms),
            displayStatus:    this._classifyDisplayDelay(r.display_delay_ms),
        }));
    }

    async _getLatencyBreakdown(accountId) {
        const rows = await queryAll(`
            SELECT
                request_delay_ms,
                display_delay_ms,
                entry_delay_ms,
                outcome,
                created_at
            FROM pairing_code_log
            WHERE account_id = $1
              AND (request_delay_ms IS NOT NULL OR display_delay_ms IS NOT NULL)
            ORDER BY created_at DESC
            LIMIT 100
        `, [accountId]);

        // ── buckets للـ request_delay (وقت توليد الكود من الخادم) ──────────
        const reqBuckets = { fast: 0, normal: 0, slow: 0, critical: 0 };
        // ── buckets للـ display_delay (إجمالي وقت انتظار المستخدم) ─────────
        const dispBuckets = { fast: 0, normal: 0, slow: 0, critical: 0 };
        // ── buckets للـ entry_delay (وقت إدخال الكود) ──────────────────────
        const entryBuckets = { fast: 0, normal: 0, slow: 0 };

        for (const r of rows) {
            if (r.request_delay_ms != null) {
                const d = r.request_delay_ms;
                if      (d < 5_000)  reqBuckets.fast++;
                else if (d < 10_000) reqBuckets.normal++;
                else if (d < 25_000) reqBuckets.slow++;
                else                 reqBuckets.critical++;
            }
            if (r.display_delay_ms != null) {
                const d = r.display_delay_ms;
                if      (d < 8_000)  dispBuckets.fast++;
                else if (d < 15_000) dispBuckets.normal++;
                else if (d < 35_000) dispBuckets.slow++;
                else                 dispBuckets.critical++;
            }
            if (r.entry_delay_ms != null) {
                const d = r.entry_delay_ms;
                if      (d < 30_000)  entryBuckets.fast++;
                else if (d < 120_000) entryBuckets.normal++;
                else                  entryBuckets.slow++;
            }
        }

        const total = rows.length;
        const pct   = (n) => total ? Math.round(n / total * 100) : 0;

        // آخر 10 عمليات (للرسم البياني)
        const trend = rows.slice(0, 10).reverse().map((r, i) => ({
            index:          i + 1,
            requestDelayMs: r.request_delay_ms,
            displayDelayMs: r.display_delay_ms,
            outcome:        r.outcome,
            createdAt:      r.created_at,
        }));

        return {
            totalSamples: total,
            requestDelayBuckets: {
                fast:     { count: reqBuckets.fast,     label: '< 5 ث',   pct: pct(reqBuckets.fast)     },
                normal:   { count: reqBuckets.normal,   label: '5-10 ث',  pct: pct(reqBuckets.normal)   },
                slow:     { count: reqBuckets.slow,     label: '10-25 ث', pct: pct(reqBuckets.slow)     },
                critical: { count: reqBuckets.critical, label: '> 25 ث',  pct: pct(reqBuckets.critical) },
            },
            displayDelayBuckets: {
                fast:     { count: dispBuckets.fast,     label: '< 8 ث',   pct: pct(dispBuckets.fast)     },
                normal:   { count: dispBuckets.normal,   label: '8-15 ث',  pct: pct(dispBuckets.normal)   },
                slow:     { count: dispBuckets.slow,     label: '15-35 ث', pct: pct(dispBuckets.slow)     },
                critical: { count: dispBuckets.critical, label: '> 35 ث',  pct: pct(dispBuckets.critical) },
            },
            entryDelayBuckets: {
                fast:   { count: entryBuckets.fast,   label: '< 30 ث',  pct: pct(entryBuckets.fast)   },
                normal: { count: entryBuckets.normal, label: '30-120 ث', pct: pct(entryBuckets.normal) },
                slow:   { count: entryBuckets.slow,   label: '> 120 ث', pct: pct(entryBuckets.slow)   },
            },
            trend,
        };
    }

    async _detectAccountIssues(accountId) {
        const stats  = await this._getAccountStats(accountId);
        const issues = [];

        if (stats.total === 0) return issues;

        // ── نسبة نجاح منخفضة ────────────────────────────────────────────
        if (stats.successRate !== null && stats.successRate < THRESHOLDS.LOW_SUCCESS_RATE) {
            issues.push({
                code:     'LOW_PAIRING_SUCCESS_RATE',
                severity: stats.successRate < 25 ? 'critical' : 'warning',
                message:  `نسبة نجاح Pairing Code منخفضة: ${stats.successRate}% (${stats.connected}/${stats.total})`,
                value:    stats.successRate,
            });
        }

        // ── معدل Timeout مرتفع ───────────────────────────────────────────
        if (stats.timeoutRate !== null && stats.timeoutRate > THRESHOLDS.HIGH_TIMEOUT_RATE) {
            issues.push({
                code:     'HIGH_PAIRING_TIMEOUT_RATE',
                severity: stats.timeoutRate > 60 ? 'critical' : 'warning',
                message:  `معدل انتهاء مهلة توليد Pairing Code مرتفع: ${stats.timeoutRate}% (${stats.timeout}/${stats.total})`,
                value:    stats.timeoutRate,
            });
        }

        // ── معدل أخطاء الخادم مرتفع ─────────────────────────────────────
        if (stats.errorRate !== null && stats.errorRate > THRESHOLDS.HIGH_ERROR_RATE) {
            issues.push({
                code:     'HIGH_PAIRING_ERROR_RATE',
                severity: stats.errorRate > 50 ? 'critical' : 'warning',
                message:  `معدل أخطاء requestPairingCode مرتفع: ${stats.errorRate}% (${stats.errors}/${stats.total})`,
                value:    stats.errorRate,
            });
        }

        // ── بطء في استلام الكود من الخادم ───────────────────────────────
        if (stats.avgRequestDelayMs > THRESHOLDS.REQUEST_DELAY_CRITICAL_MS) {
            issues.push({
                code:     'PAIRING_REQUEST_VERY_SLOW',
                severity: 'critical',
                message:  `متوسط وقت استلام Pairing Code بطيء جداً: ${Math.round(stats.avgRequestDelayMs / 1000)} ث (> 25 ث)`,
                value:    stats.avgRequestDelayMs,
            });
        } else if (stats.avgRequestDelayMs > THRESHOLDS.REQUEST_DELAY_WARN_MS) {
            issues.push({
                code:     'PAIRING_REQUEST_SLOW',
                severity: 'warning',
                message:  `متوسط وقت استلام Pairing Code بطيء: ${Math.round(stats.avgRequestDelayMs / 1000)} ث (> 10 ث)`,
                value:    stats.avgRequestDelayMs,
            });
        }

        // ── بطء في الوقت الإجمالي لعرض الكود للمستخدم ───────────────────
        if (stats.avgDisplayDelayMs > THRESHOLDS.DISPLAY_DELAY_CRITICAL_MS) {
            issues.push({
                code:     'PAIRING_DISPLAY_VERY_SLOW',
                severity: 'critical',
                message:  `وقت عرض Pairing Code للمستخدم بطيء جداً: ${Math.round(stats.avgDisplayDelayMs / 1000)} ث (> 35 ث)`,
                value:    stats.avgDisplayDelayMs,
            });
        } else if (stats.avgDisplayDelayMs > THRESHOLDS.DISPLAY_DELAY_WARN_MS) {
            issues.push({
                code:     'PAIRING_DISPLAY_SLOW',
                severity: 'warning',
                message:  `وقت عرض Pairing Code للمستخدم بطيء: ${Math.round(stats.avgDisplayDelayMs / 1000)} ث (> 15 ث)`,
                value:    stats.avgDisplayDelayMs,
            });
        }

        return issues;
    }

    async _getSystemStats() {
        const row = await queryOne(`
            SELECT
                COUNT(DISTINCT account_id)                                        AS total_accounts,
                COUNT(*)                                                          AS total,
                COUNT(*) FILTER (WHERE outcome = 'connected')                    AS total_connected,
                COUNT(*) FILTER (WHERE outcome = 'entered')                      AS total_entered,
                COUNT(*) FILTER (WHERE outcome = 'timeout')                      AS total_timeout,
                COUNT(*) FILTER (WHERE outcome = 'error')                        AS total_errors,
                COUNT(*) FILTER (WHERE outcome = 'cancelled')                    AS total_cancelled,
                COUNT(*) FILTER (WHERE outcome = 'failed')                       AS total_failed,
                COUNT(*) FILTER (WHERE outcome = 'pending')                      AS total_pending,

                ROUND(AVG(request_delay_ms) FILTER (WHERE request_delay_ms IS NOT NULL))::int
                                                                                 AS avg_request_delay_ms,
                ROUND(AVG(display_delay_ms) FILTER (WHERE display_delay_ms IS NOT NULL))::int
                                                                                 AS avg_display_delay_ms,
                ROUND(AVG(entry_delay_ms)   FILTER (WHERE entry_delay_ms   IS NOT NULL))::int
                                                                                 AS avg_entry_delay_ms,
                MAX(created_at)                                                  AS last_attempt_at
            FROM pairing_code_log
        `);

        const total     = parseInt(row?.total           || 0);
        const connected = parseInt(row?.total_connected || 0);
        const timeout   = parseInt(row?.total_timeout   || 0);

        return {
            totalAccounts:        parseInt(row?.total_accounts   || 0),
            total,
            totalConnected:       connected,
            totalEntered:         parseInt(row?.total_entered    || 0),
            totalTimeout:         timeout,
            totalErrors:          parseInt(row?.total_errors     || 0),
            totalCancelled:       parseInt(row?.total_cancelled  || 0),
            totalFailed:          parseInt(row?.total_failed     || 0),
            totalPending:         parseInt(row?.total_pending    || 0),
            systemSuccessRate:    total > 0 ? Math.round((connected / total) * 100) : null,
            systemTimeoutRate:    total > 0 ? Math.round((timeout   / total) * 100) : null,
            avgRequestDelayMs:    row?.avg_request_delay_ms || null,
            avgDisplayDelayMs:    row?.avg_display_delay_ms || null,
            avgEntryDelayMs:      row?.avg_entry_delay_ms   || null,
            lastAttemptAt:        row?.last_attempt_at      || null,
        };
    }

    async _getProblematicAccounts(limit = 20) {
        const rows = await queryAll(`
            SELECT
                account_id,
                COUNT(*)                                                          AS total,
                COUNT(*) FILTER (WHERE outcome = 'connected')                    AS connected,
                COUNT(*) FILTER (WHERE outcome = 'timeout')                      AS timeout_count,
                COUNT(*) FILTER (WHERE outcome = 'error')                        AS error_count,
                ROUND(AVG(request_delay_ms) FILTER (WHERE request_delay_ms IS NOT NULL))::int
                                                                                 AS avg_request_delay_ms,
                ROUND(AVG(display_delay_ms) FILTER (WHERE display_delay_ms IS NOT NULL))::int
                                                                                 AS avg_display_delay_ms,
                MAX(created_at)                                                  AS last_attempt_at
            FROM pairing_code_log
            GROUP BY account_id
            HAVING COUNT(*) >= 2
            ORDER BY
                CASE
                    WHEN COUNT(*) > 0 THEN
                        ROUND(100.0 * COUNT(*) FILTER (WHERE outcome IN ('timeout','error','failed')) / COUNT(*))
                    ELSE 0
                END DESC,
                avg_request_delay_ms DESC NULLS LAST
            LIMIT $1
        `, [limit]);

        return rows.map(r => {
            const total     = parseInt(r.total);
            const connected = parseInt(r.connected);
            const timeout   = parseInt(r.timeout_count);
            const errors    = parseInt(r.error_count);
            return {
                accountId:          r.account_id,
                total,
                connected,
                timeout,
                errors,
                successRate:        total > 0 ? Math.round((connected / total) * 100) : null,
                timeoutRate:        total > 0 ? Math.round((timeout   / total) * 100) : null,
                errorRate:          total > 0 ? Math.round((errors    / total) * 100) : null,
                avgRequestDelayMs:  r.avg_request_delay_ms,
                avgDisplayDelayMs:  r.avg_display_delay_ms,
                lastAttemptAt:      r.last_attempt_at,
                requestStatus:      this._classifyRequestDelay(r.avg_request_delay_ms),
            };
        });
    }

    async _getRecentSystemActivity(limit = 30) {
        const rows = await queryAll(`
            SELECT
                account_id,
                phone_number,
                outcome,
                request_delay_ms,
                display_delay_ms,
                entry_delay_ms,
                error_message,
                created_at
            FROM pairing_code_log
            ORDER BY created_at DESC
            LIMIT $1
        `, [limit]);

        return rows.map(r => ({
            accountId:       r.account_id,
            phoneNumber:     r.phone_number,
            outcome:         r.outcome,
            requestDelayMs:  r.request_delay_ms,
            displayDelayMs:  r.display_delay_ms,
            entryDelayMs:    r.entry_delay_ms,
            errorMessage:    r.error_message,
            createdAt:       r.created_at,
            requestStatus:   this._classifyRequestDelay(r.request_delay_ms),
        }));
    }

    // ══════════════════════════════════════════════════════════════════════
    //  مساعدات داخلية
    // ══════════════════════════════════════════════════════════════════════

    async _closeActive(accountId, outcome) {
        try {
            const active = this._active.get(accountId);
            if (!active) return;
            await query(`
                UPDATE pairing_code_log
                SET outcome = $1
                WHERE id = $2 AND outcome IN ('pending', 'entered')
            `, [outcome, active.logId]);
            this._active.delete(accountId);
        } catch (err) {
            console.warn(`[PairingCodeAnalyzer] _closeActive error:`, err.message);
        }
    }

    async _getCurrentAttemptId(accountId) {
        try {
            const row = await queryOne(`
                SELECT id FROM connection_attempts
                WHERE account_id = $1 AND outcome = 'in_progress'
                ORDER BY started_at DESC LIMIT 1
            `, [accountId]);
            return row?.id || null;
        } catch {
            return null;
        }
    }

    _classifyRequestDelay(ms) {
        if (ms == null)   return 'unknown';
        if (ms < 5_000)   return 'fast';
        if (ms < 10_000)  return 'normal';
        if (ms < 25_000)  return 'slow';
        return 'critical';
    }

    _classifyDisplayDelay(ms) {
        if (ms == null)   return 'unknown';
        if (ms < 8_000)   return 'fast';
        if (ms < 15_000)  return 'normal';
        if (ms < 35_000)  return 'slow';
        return 'critical';
    }

    _deriveStatus(issues) {
        if (!issues || issues.length === 0)               return 'healthy';
        if (issues.some(i => i.severity === 'critical'))  return 'critical';
        if (issues.some(i => i.severity === 'warning'))   return 'warning';
        return 'healthy';
    }
}

module.exports = new PairingCodeAnalyzer();
