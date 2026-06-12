'use strict';
/**
 * QRAnalyzer.js — المرحلة السابعة: تحليل QR Code
 *
 * مهام هذه الوحدة:
 *   1. تتبع كل رمز QR يُولَّد: وقت التوليد، وقت المسح، النتيجة
 *   2. قياس زمن التأخير (Generation Delay) من لحظة الطلب حتى ظهور QR
 *   3. رصد أنماط الفشل: timeout، انتهاء الصلاحية، رفض الاتصال
 *   4. كشف الحسابات ذات الـ QR البطيء أو كثير الانتهاء
 *   5. تقارير: per-account + system-wide
 *
 * مصادر البيانات:
 *   - جدول qr_flow_log  (جديد — تفاصيل كل QR)
 *   - جدول connection_attempts  (للربط بالمحاولة الكاملة)
 *   - جدول connection_events    (لأحداث qr_generated)
 *   - جدول connection_stage_transitions (لزمن مرحلة qr_generating)
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const crypto = require('crypto');

// ── حدود التحذير ──────────────────────────────────────────────────────────
const THRESHOLDS = {
    GEN_DELAY_WARN_MS:     8_000,   // > 8 ث توليد → تحذير
    GEN_DELAY_CRITICAL_MS: 20_000,  // > 20 ث توليد → حرج
    SCAN_DELAY_WARN_MS:    30_000,  // > 30 ث مسح → بطيء
    LOW_SUCCESS_RATE:      50,      // < 50% نجاح → مشكلة
    HIGH_TIMEOUT_RATE:     30,      // > 30% timeout → مشكلة
    HISTORY_LIMIT:         50,      // أقصى عدد سجلات في التاريخ
};

// ── نتائج QR ──────────────────────────────────────────────────────────────
const QR_OUTCOMES = {
    PENDING:   'pending',
    SCANNED:   'scanned',    // مُسح → اتصال ناجح
    EXPIRED:   'expired',    // انتهت صلاحيته (60 ث) دون مسح
    TIMEOUT:   'timeout',    // لم يُولَّد في 30 ث
    CANCELLED: 'cancelled',  // ألغيت المحاولة قبل المسح
    FAILED:    'failed',     // مُسح لكن الاتصال فشل
};

// ═══════════════════════════════════════════════════════════════════════════

class QRAnalyzer {

    constructor() {
        // تتبع QR النشط: accountId → { logId, generatedAt, attemptId }
        this._activeQR = new Map();
        // وقت بدء مرحلة qr_generating: accountId → timestamp
        this._generatingStartAt = new Map();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Hooks — تُستدعى من WhatsAppManager
    // ══════════════════════════════════════════════════════════════════════

    /**
     * عند دخول حالة qr_generating
     * @param {string} accountId
     */
    onQRGenerating(accountId) {
        this._generatingStartAt.set(accountId, Date.now());
    }

    /**
     * عند توليد QR جديد
     * @param {string} accountId
     * @param {string|null} attemptId
     * @param {number} [qrIndex=1]  رقم QR في المحاولة الحالية
     */
    async onQRGenerated(accountId, attemptId = null, qrIndex = 1) {
        try {
            const now = Date.now();
            const startTs = this._generatingStartAt.get(accountId);
            const generationDelayMs = startTs ? (now - startTs) : null;

            // إنهاء QR السابق إن وُجد (expired)
            await this._closeActiveQR(accountId, QR_OUTCOMES.EXPIRED);

            const logId = crypto.randomUUID();
            await query(`
                INSERT INTO qr_flow_log
                    (id, account_id, attempt_id, qr_index, generation_delay_ms, generated_at, outcome)
                VALUES ($1, $2, $3, $4, $5, NOW(), 'pending')
            `, [logId, accountId, attemptId, qrIndex, generationDelayMs]);

            this._activeQR.set(accountId, {
                logId,
                generatedAt: now,
                attemptId,
                qrIndex,
            });

            // إعادة تعيين مؤقت التوليد للـ QR القادم
            this._generatingStartAt.set(accountId, now);
        } catch (err) {
            console.warn(`[QRAnalyzer] onQRGenerated error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند مسح QR بنجاح (استقبال كود 515 مع qrWasJustScanned=true)
     * @param {string} accountId
     */
    async onQRScanned(accountId) {
        try {
            const active = this._activeQR.get(accountId);
            if (!active) return;

            const scanDelayMs = Date.now() - active.generatedAt;

            await query(`
                UPDATE qr_flow_log
                SET outcome = 'scanned', scan_delay_ms = $1, scanned_at = NOW()
                WHERE id = $2
            `, [scanDelayMs, active.logId]);

            this._activeQR.delete(accountId);
            this._generatingStartAt.delete(accountId);
        } catch (err) {
            console.warn(`[QRAnalyzer] onQRScanned error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند نجاح الاتصال (connected) بعد QR
     * @param {string} accountId
     */
    async onQRSuccess(accountId) {
        // إذا لم يُسجَّل scanned صراحةً، نعتبره scanned عند الاتصال
        const active = this._activeQR.get(accountId);
        if (active) {
            await this.onQRScanned(accountId);
        }
    }

    /**
     * عند انتهاء مهلة توليد QR (30 ث)
     * @param {string} accountId
     */
    async onQRTimeout(accountId) {
        try {
            const active = this._activeQR.get(accountId);
            if (active) {
                await query(`
                    UPDATE qr_flow_log SET outcome = 'timeout' WHERE id = $1
                `, [active.logId]);
                this._activeQR.delete(accountId);
            } else {
                // لم يُولَّد QR أصلاً → سجّل حدث timeout
                const logId = crypto.randomUUID();
                const attempt = await queryOne(`
                    SELECT id FROM connection_attempts
                    WHERE account_id = $1 AND outcome = 'in_progress'
                    ORDER BY started_at DESC LIMIT 1
                `, [accountId]);

                await query(`
                    INSERT INTO qr_flow_log
                        (id, account_id, attempt_id, qr_index, generated_at, outcome)
                    VALUES ($1, $2, $3, 1, NOW(), 'timeout')
                `, [logId, accountId, attempt?.id || null]);
            }

            this._generatingStartAt.delete(accountId);
        } catch (err) {
            console.warn(`[QRAnalyzer] onQRTimeout error for ${accountId}:`, err.message);
        }
    }

    /**
     * عند إلغاء المحاولة أو مسح الجلسة
     * @param {string} accountId
     */
    async onQRCancelled(accountId) {
        await this._closeActiveQR(accountId, QR_OUTCOMES.CANCELLED);
        this._generatingStartAt.delete(accountId);
    }

    /**
     * عند فشل الاتصال بعد المسح
     * @param {string} accountId
     */
    async onQRScanFailed(accountId) {
        try {
            const active = this._activeQR.get(accountId);
            if (!active) return;
            await query(`
                UPDATE qr_flow_log SET outcome = 'failed' WHERE id = $1
            `, [active.logId]);
            this._activeQR.delete(accountId);
        } catch (err) {
            console.warn(`[QRAnalyzer] onQRScanFailed error for ${accountId}:`, err.message);
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  تحليل Per-Account
    // ══════════════════════════════════════════════════════════════════════

    /**
     * تقرير شامل لـ QR لحساب محدد
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
            status:        this._deriveStatus(issues),
            issues,
            stats,
            latency,
            history,
            analyzedAt:    new Date().toISOString(),
            durationMs:    Date.now() - startTs,
        };
    }

    /**
     * إحصائيات QR لحساب محدد
     */
    async getAccountStats(accountId) {
        return this._getAccountStats(accountId);
    }

    /**
     * تاريخ QR لحساب محدد
     */
    async getAccountHistory(accountId, limit = THRESHOLDS.HISTORY_LIMIT) {
        return this._getAccountHistory(accountId, limit);
    }

    /**
     * تحليل التأخير (latency) لحساب محدد
     */
    async getLatencyBreakdown(accountId) {
        return this._getLatencyBreakdown(accountId);
    }

    // ══════════════════════════════════════════════════════════════════════
    //  تحليل System-Wide
    // ══════════════════════════════════════════════════════════════════════

    /**
     * تقرير شامل لكل الحسابات
     */
    async generateSystemReport() {
        const startTs = Date.now();

        const [stats, slowAccounts, recentActivity] = await Promise.all([
            this._getSystemStats(),
            this._getSlowAccounts(),
            this._getRecentSystemActivity(),
        ]);

        return {
            stats,
            slowAccounts,
            recentActivity,
            generatedAt:  new Date().toISOString(),
            durationMs:   Date.now() - startTs,
        };
    }

    /**
     * إحصائيات إجمالية للنظام
     */
    async getSystemStats() {
        return this._getSystemStats();
    }

    /**
     * الحسابات ذات QR بطيء التوليد أو منخفض نسبة النجاح
     */
    async getSlowAccounts() {
        return this._getSlowAccounts();
    }

    // ══════════════════════════════════════════════════════════════════════
    //  الدوال الداخلية
    // ══════════════════════════════════════════════════════════════════════

    async _getAccountStats(accountId) {
        const row = await queryOne(`
            SELECT
                COUNT(*)                                                        AS total_qr,
                COUNT(*) FILTER (WHERE outcome = 'scanned')                     AS scanned,
                COUNT(*) FILTER (WHERE outcome = 'expired')                     AS expired,
                COUNT(*) FILTER (WHERE outcome = 'timeout')                     AS timeout_count,
                COUNT(*) FILTER (WHERE outcome = 'cancelled')                   AS cancelled,
                COUNT(*) FILTER (WHERE outcome = 'failed')                      AS failed,
                COUNT(*) FILTER (WHERE outcome = 'pending')                     AS pending,
                ROUND(AVG(generation_delay_ms) FILTER (WHERE generation_delay_ms IS NOT NULL))::int
                                                                                AS avg_gen_delay_ms,
                MAX(generation_delay_ms)                                        AS max_gen_delay_ms,
                MIN(generation_delay_ms) FILTER (WHERE generation_delay_ms > 0) AS min_gen_delay_ms,
                ROUND(AVG(scan_delay_ms) FILTER (WHERE scan_delay_ms IS NOT NULL))::int
                                                                                AS avg_scan_delay_ms,
                MAX(generated_at)                                               AS last_qr_at,
                MIN(generated_at)                                               AS first_qr_at
            FROM qr_flow_log
            WHERE account_id = $1
        `, [accountId]);

        const total  = parseInt(row?.total_qr    || 0);
        const scanned = parseInt(row?.scanned    || 0);
        const timeoutCount = parseInt(row?.timeout_count || 0);

        return {
            totalQR:         total,
            scanned:         scanned,
            expired:         parseInt(row?.expired   || 0),
            timeout:         timeoutCount,
            cancelled:       parseInt(row?.cancelled || 0),
            failed:          parseInt(row?.failed    || 0),
            pending:         parseInt(row?.pending   || 0),
            successRate:     total > 0 ? Math.round((scanned / total) * 100) : null,
            timeoutRate:     total > 0 ? Math.round((timeoutCount / total) * 100) : null,
            avgGenDelayMs:   row?.avg_gen_delay_ms || null,
            maxGenDelayMs:   row?.max_gen_delay_ms || null,
            minGenDelayMs:   row?.min_gen_delay_ms || null,
            avgScanDelayMs:  row?.avg_scan_delay_ms || null,
            lastQRAt:        row?.last_qr_at || null,
            firstQRAt:       row?.first_qr_at || null,
        };
    }

    async _getAccountHistory(accountId, limit = 20) {
        const rows = await queryAll(`
            SELECT
                q.id,
                q.attempt_id,
                q.qr_index,
                q.generation_delay_ms,
                q.generated_at,
                q.scanned_at,
                q.scan_delay_ms,
                q.outcome,
                q.created_at,
                a.connection_type,
                a.reconnect_attempt
            FROM qr_flow_log q
            LEFT JOIN connection_attempts a ON a.id = q.attempt_id
            WHERE q.account_id = $1
            ORDER BY q.generated_at DESC
            LIMIT $2
        `, [accountId, limit]);

        return rows.map(r => ({
            id:               r.id,
            attemptId:        r.attempt_id,
            qrIndex:          r.qr_index,
            generationDelayMs: r.generation_delay_ms,
            generatedAt:      r.generated_at,
            scannedAt:        r.scanned_at,
            scanDelayMs:      r.scan_delay_ms,
            outcome:          r.outcome,
            connectionType:   r.connection_type,
            reconnectAttempt: r.reconnect_attempt,
            genDelayStatus:   this._classifyDelay(r.generation_delay_ms),
        }));
    }

    async _getLatencyBreakdown(accountId) {
        // توزيع أوقات التوليد في buckets
        const rows = await queryAll(`
            SELECT
                generation_delay_ms,
                scan_delay_ms,
                outcome,
                generated_at
            FROM qr_flow_log
            WHERE account_id = $1
              AND generation_delay_ms IS NOT NULL
            ORDER BY generated_at DESC
            LIMIT 100
        `, [accountId]);

        const buckets = { fast: 0, normal: 0, slow: 0, critical: 0 };
        const scanBuckets = { fast: 0, normal: 0, slow: 0 };

        for (const r of rows) {
            const d = r.generation_delay_ms;
            if (d < 3000)      buckets.fast++;
            else if (d < 8000) buckets.normal++;
            else if (d < 20000) buckets.slow++;
            else               buckets.critical++;

            if (r.scan_delay_ms != null) {
                const s = r.scan_delay_ms;
                if (s < 15000)       scanBuckets.fast++;
                else if (s < 30000)  scanBuckets.normal++;
                else                 scanBuckets.slow++;
            }
        }

        const total = rows.length;

        // آخر 10 أوقات توليد (للرسم البياني)
        const trend = rows.slice(0, 10).reverse().map((r, i) => ({
            index:           i + 1,
            generationDelayMs: r.generation_delay_ms,
            outcome:         r.outcome,
            generatedAt:     r.generated_at,
        }));

        return {
            totalSamples: total,
            generationBuckets: {
                fast:     { count: buckets.fast,     label: '< 3 ث',   pct: total ? Math.round(buckets.fast / total * 100) : 0 },
                normal:   { count: buckets.normal,   label: '3-8 ث',   pct: total ? Math.round(buckets.normal / total * 100) : 0 },
                slow:     { count: buckets.slow,     label: '8-20 ث',  pct: total ? Math.round(buckets.slow / total * 100) : 0 },
                critical: { count: buckets.critical, label: '> 20 ث',  pct: total ? Math.round(buckets.critical / total * 100) : 0 },
            },
            scanBuckets: {
                fast:   { count: scanBuckets.fast,   label: '< 15 ث',  pct: total ? Math.round(scanBuckets.fast / total * 100) : 0 },
                normal: { count: scanBuckets.normal, label: '15-30 ث', pct: total ? Math.round(scanBuckets.normal / total * 100) : 0 },
                slow:   { count: scanBuckets.slow,   label: '> 30 ث',  pct: total ? Math.round(scanBuckets.slow / total * 100) : 0 },
            },
            trend,
        };
    }

    async _detectAccountIssues(accountId) {
        const stats = await this._getAccountStats(accountId);
        const issues = [];

        if (stats.totalQR === 0) {
            return issues; // لا سجلات بعد
        }

        // ── نسبة نجاح منخفضة
        if (stats.successRate !== null && stats.successRate < THRESHOLDS.LOW_SUCCESS_RATE) {
            issues.push({
                code:     'LOW_QR_SUCCESS_RATE',
                severity: stats.successRate < 25 ? 'critical' : 'warning',
                message:  `نسبة نجاح QR منخفضة: ${stats.successRate}% (${stats.scanned}/${stats.totalQR})`,
                value:    stats.successRate,
            });
        }

        // ── معدل timeout مرتفع
        if (stats.timeoutRate !== null && stats.timeoutRate > THRESHOLDS.HIGH_TIMEOUT_RATE) {
            issues.push({
                code:     'HIGH_QR_TIMEOUT_RATE',
                severity: stats.timeoutRate > 60 ? 'critical' : 'warning',
                message:  `معدل انتهاء مهلة توليد QR مرتفع: ${stats.timeoutRate}% (${stats.timeout}/${stats.totalQR})`,
                value:    stats.timeoutRate,
            });
        }

        // ── بطء في توليد QR
        if (stats.avgGenDelayMs > THRESHOLDS.GEN_DELAY_CRITICAL_MS) {
            issues.push({
                code:     'QR_GENERATION_VERY_SLOW',
                severity: 'critical',
                message:  `متوسط وقت توليد QR بطيء جداً: ${Math.round(stats.avgGenDelayMs / 1000)} ث (> 20 ث)`,
                value:    stats.avgGenDelayMs,
            });
        } else if (stats.avgGenDelayMs > THRESHOLDS.GEN_DELAY_WARN_MS) {
            issues.push({
                code:     'QR_GENERATION_SLOW',
                severity: 'warning',
                message:  `متوسط وقت توليد QR بطيء: ${Math.round(stats.avgGenDelayMs / 1000)} ث (> 8 ث)`,
                value:    stats.avgGenDelayMs,
            });
        }

        // ── انتهاء صلاحية متكرر
        const expiredRate = stats.totalQR > 0 ? Math.round((stats.expired / stats.totalQR) * 100) : 0;
        if (expiredRate > 40) {
            issues.push({
                code:     'HIGH_QR_EXPIRY_RATE',
                severity: 'warning',
                message:  `انتهاء صلاحية QR قبل المسح بنسبة عالية: ${expiredRate}% (${stats.expired}/${stats.totalQR})`,
                value:    expiredRate,
            });
        }

        return issues;
    }

    async _getSystemStats() {
        const row = await queryOne(`
            SELECT
                COUNT(DISTINCT account_id)                                      AS total_accounts,
                COUNT(*)                                                        AS total_qr,
                COUNT(*) FILTER (WHERE outcome = 'scanned')                     AS total_scanned,
                COUNT(*) FILTER (WHERE outcome = 'expired')                     AS total_expired,
                COUNT(*) FILTER (WHERE outcome = 'timeout')                     AS total_timeout,
                COUNT(*) FILTER (WHERE outcome = 'cancelled')                   AS total_cancelled,
                COUNT(*) FILTER (WHERE outcome = 'failed')                      AS total_failed,
                COUNT(*) FILTER (WHERE outcome = 'pending')                     AS total_pending,
                ROUND(AVG(generation_delay_ms) FILTER (WHERE generation_delay_ms IS NOT NULL))::int
                                                                                AS avg_gen_delay_ms,
                ROUND(AVG(scan_delay_ms) FILTER (WHERE scan_delay_ms IS NOT NULL))::int
                                                                                AS avg_scan_delay_ms,
                MAX(generated_at)                                               AS last_qr_at
            FROM qr_flow_log
        `);

        const total   = parseInt(row?.total_qr      || 0);
        const scanned = parseInt(row?.total_scanned || 0);
        const timeout = parseInt(row?.total_timeout || 0);

        return {
            totalAccounts:   parseInt(row?.total_accounts || 0),
            totalQR:         total,
            totalScanned:    scanned,
            totalExpired:    parseInt(row?.total_expired   || 0),
            totalTimeout:    timeout,
            totalCancelled:  parseInt(row?.total_cancelled || 0),
            totalFailed:     parseInt(row?.total_failed    || 0),
            totalPending:    parseInt(row?.total_pending   || 0),
            systemSuccessRate: total > 0 ? Math.round((scanned / total) * 100) : null,
            systemTimeoutRate: total > 0 ? Math.round((timeout / total) * 100) : null,
            avgGenDelayMs:   row?.avg_gen_delay_ms  || null,
            avgScanDelayMs:  row?.avg_scan_delay_ms || null,
            lastQRAt:        row?.last_qr_at        || null,
        };
    }

    async _getSlowAccounts(limit = 20) {
        const rows = await queryAll(`
            SELECT
                account_id,
                COUNT(*)                                                         AS total_qr,
                COUNT(*) FILTER (WHERE outcome = 'scanned')                      AS scanned,
                COUNT(*) FILTER (WHERE outcome = 'timeout')                      AS timeout_count,
                COUNT(*) FILTER (WHERE outcome = 'expired')                      AS expired,
                ROUND(AVG(generation_delay_ms) FILTER (WHERE generation_delay_ms IS NOT NULL))::int
                                                                                 AS avg_gen_delay_ms,
                MAX(generated_at)                                                AS last_qr_at
            FROM qr_flow_log
            GROUP BY account_id
            HAVING COUNT(*) >= 2
            ORDER BY avg_gen_delay_ms DESC NULLS LAST
            LIMIT $1
        `, [limit]);

        return rows.map(r => {
            const total   = parseInt(r.total_qr);
            const scanned = parseInt(r.scanned);
            const timeout = parseInt(r.timeout_count);
            return {
                accountId:      r.account_id,
                totalQR:        total,
                scanned:        scanned,
                timeout:        timeout,
                expired:        parseInt(r.expired),
                successRate:    total > 0 ? Math.round((scanned / total) * 100) : null,
                timeoutRate:    total > 0 ? Math.round((timeout / total) * 100) : null,
                avgGenDelayMs:  r.avg_gen_delay_ms,
                lastQRAt:       r.last_qr_at,
                severity:       this._classifyDelay(r.avg_gen_delay_ms),
            };
        });
    }

    async _getRecentSystemActivity(limit = 30) {
        const rows = await queryAll(`
            SELECT
                account_id,
                outcome,
                generation_delay_ms,
                scan_delay_ms,
                generated_at,
                scanned_at
            FROM qr_flow_log
            ORDER BY generated_at DESC
            LIMIT $1
        `, [limit]);

        return rows.map(r => ({
            accountId:        r.account_id,
            outcome:          r.outcome,
            generationDelayMs: r.generation_delay_ms,
            scanDelayMs:      r.scan_delay_ms,
            generatedAt:      r.generated_at,
            scannedAt:        r.scanned_at,
            genDelayStatus:   this._classifyDelay(r.generation_delay_ms),
        }));
    }

    // ══════════════════════════════════════════════════════════════════════
    //  مساعدات داخلية
    // ══════════════════════════════════════════════════════════════════════

    async _closeActiveQR(accountId, outcome) {
        try {
            const active = this._activeQR.get(accountId);
            if (!active) return;

            await query(`
                UPDATE qr_flow_log SET outcome = $1 WHERE id = $2 AND outcome = 'pending'
            `, [outcome, active.logId]);

            this._activeQR.delete(accountId);
        } catch (err) {
            console.warn(`[QRAnalyzer] _closeActiveQR error:`, err.message);
        }
    }

    _classifyDelay(ms) {
        if (ms == null)  return 'unknown';
        if (ms < 3000)   return 'fast';
        if (ms < 8000)   return 'normal';
        if (ms < 20000)  return 'slow';
        return 'critical';
    }

    _deriveStatus(issues) {
        if (!issues || issues.length === 0) return 'healthy';
        if (issues.some(i => i.severity === 'critical')) return 'critical';
        if (issues.some(i => i.severity === 'warning'))  return 'warning';
        return 'healthy';
    }
}

module.exports = new QRAnalyzer();
