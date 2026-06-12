'use strict';
/**
 * ConnectionCycleAnalyzer.js — المرحلة الثالثة: تحليل دورة الاتصال الكاملة
 *
 * يرصد ويحلل كل انتقال بين مراحل الاتصال بدقة زمنية كاملة:
 *  - تسجيل timestamp دقيق لكل انتقال حالة (stage transition)
 *  - حساب الوقت الفعلي في كل مرحلة (time_in_stage_ms)
 *  - كشف الانتقالات غير المتوقعة (unexpected transitions)
 *  - مقارنة الدورة الفعلية مع النمط المثالي المتوقع
 *  - توليد تقارير: "تأخر غير طبيعي في مرحلة X"
 *  - بناء State Machine Map كاملة لكل محاولة
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const crypto = require('crypto');

// ══════════════════════════════════════════════════════════════════════════════
//  تعريف مراحل الاتصال
// ══════════════════════════════════════════════════════════════════════════════

const STAGES = {
    INITIALIZING:       'initializing',
    QR_GENERATING:      'qr_generating',
    QR_READY:           'qr_ready',
    SCANNING:           'scanning',
    CONNECTING:         'connecting',
    CONNECTED:          'connected',
    PAIRING_STARTING:   'pairing_starting',
    PAIRING_GENERATING: 'pairing_generating',
    PAIRING_READY:      'pairing_ready',
    DISCONNECTED:       'disconnected',
    ERROR:              'error',
};

// ── الانتقالات المثالية (Expected State Machine) ───────────────────────────
const EXPECTED_TRANSITIONS = {
    // مسار QR Code
    qr_code: [
        STAGES.INITIALIZING,
        STAGES.QR_GENERATING,
        STAGES.QR_READY,
        STAGES.CONNECTING,
        STAGES.CONNECTED,
    ],
    // مسار Pairing Code
    pairing_code: [
        STAGES.INITIALIZING,
        STAGES.PAIRING_STARTING,
        STAGES.PAIRING_GENERATING,
        STAGES.PAIRING_READY,
        STAGES.CONNECTING,
        STAGES.CONNECTED,
    ],
};

// ── المدد الزمنية المتوقعة لكل مرحلة (بالمللي ثانية) ──────────────────────
const STAGE_THRESHOLDS = {
    [STAGES.INITIALIZING]:       { warnMs: 3_000,  criticalMs: 8_000  }, // إعداد Socket
    [STAGES.QR_GENERATING]:      { warnMs: 5_000,  criticalMs: 15_000 }, // توليد QR
    [STAGES.QR_READY]:           { warnMs: 30_000, criticalMs: 60_000 }, // انتظار مسح المستخدم
    [STAGES.SCANNING]:           { warnMs: 5_000,  criticalMs: 15_000 }, // مسح QR
    [STAGES.CONNECTING]:         { warnMs: 5_000,  criticalMs: 15_000 }, // مصافحة واتساب
    [STAGES.PAIRING_STARTING]:   { warnMs: 2_000,  criticalMs: 5_000  }, // بدء Pairing
    [STAGES.PAIRING_GENERATING]: { warnMs: 5_000,  criticalMs: 15_000 }, // إنشاء الكود
    [STAGES.PAIRING_READY]:      { warnMs: 30_000, criticalMs: 60_000 }, // انتظار إدخال المستخدم
};

// ── الانتقالات المسموحة (Valid Transitions) ────────────────────────────────
const VALID_TRANSITIONS = new Map([
    [STAGES.INITIALIZING,       [STAGES.QR_GENERATING, STAGES.PAIRING_STARTING, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.QR_GENERATING,      [STAGES.QR_READY, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.QR_READY,           [STAGES.SCANNING, STAGES.CONNECTING, STAGES.QR_GENERATING, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.SCANNING,           [STAGES.CONNECTING, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.CONNECTING,         [STAGES.CONNECTED, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.PAIRING_STARTING,   [STAGES.PAIRING_GENERATING, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.PAIRING_GENERATING, [STAGES.PAIRING_READY, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.PAIRING_READY,      [STAGES.CONNECTING, STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.CONNECTED,          [STAGES.DISCONNECTED, STAGES.ERROR]],
    [STAGES.DISCONNECTED,       [STAGES.INITIALIZING, STAGES.ERROR]],
    [STAGES.ERROR,              [STAGES.INITIALIZING, STAGES.DISCONNECTED]],
]);

// ── أوزان التقدم نحو الاتصال (0–100) ─────────────────────────────────────
const STAGE_PROGRESS = {
    [STAGES.INITIALIZING]:       10,
    [STAGES.QR_GENERATING]:      25,
    [STAGES.QR_READY]:           40,
    [STAGES.SCANNING]:           60,
    [STAGES.PAIRING_STARTING]:   25,
    [STAGES.PAIRING_GENERATING]: 40,
    [STAGES.PAIRING_READY]:      55,
    [STAGES.CONNECTING]:         80,
    [STAGES.CONNECTED]:          100,
    [STAGES.DISCONNECTED]:       0,
    [STAGES.ERROR]:              0,
};

class ConnectionCycleAnalyzer {

    constructor() {
        // activeStages: accountId → { stage, enteredAt, attemptId, connectionType }
        this._activeStages = new Map();
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تسجيل الانتقالات
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * تسجيل انتقال مرحلة جديدة
     * يُستدعى من WhatsAppManager._emitState()
     */
    async onStageChange(accountId, newStage, extra = {}) {
        try {
            const now        = Date.now();
            const nowTs      = new Date(now);
            const active     = this._activeStages.get(accountId);
            const attemptId  = extra.attemptId || active?.attemptId || null;
            const connType   = extra.connectionType || active?.connectionType || 'qr_code';

            // ── حساب المدة في المرحلة السابقة ─────────────────────────────
            let timeInPrevStageMs = null;
            let prevStage         = null;
            let isUnexpected      = false;

            if (active) {
                prevStage         = active.stage;
                timeInPrevStageMs = now - active.enteredAt;

                // كشف الانتقال غير المتوقع
                const validNext = VALID_TRANSITIONS.get(prevStage) || [];
                isUnexpected    = !validNext.includes(newStage);
            }

            // ── حفظ الانتقال في قاعدة البيانات ───────────────────────────
            const transitionId = crypto.randomUUID();
            await query(`
                INSERT INTO connection_stage_transitions (
                    id, account_id, attempt_id, connection_type,
                    from_stage, to_stage,
                    from_stage_duration_ms,
                    transition_at,
                    is_unexpected,
                    is_terminal,
                    progress_pct,
                    extra_data
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            `, [
                transitionId,
                accountId,
                attemptId,
                connType,
                prevStage || null,
                newStage,
                timeInPrevStageMs,
                nowTs,
                isUnexpected,
                (newStage === STAGES.CONNECTED || newStage === STAGES.DISCONNECTED || newStage === STAGES.ERROR),
                STAGE_PROGRESS[newStage] ?? 0,
                JSON.stringify({
                    ...extra,
                    prevStageMs: timeInPrevStageMs,
                }),
            ]).catch(err => console.warn('[CycleAnalyzer] insert transition error:', err.message));

            // ── تحديث الحالة الداخلية ─────────────────────────────────────
            this._activeStages.set(accountId, {
                stage:          newStage,
                enteredAt:      now,
                attemptId,
                connectionType: connType,
            });

            // ── تحليل التأخير في الوقت الفعلي ─────────────────────────────
            if (prevStage && timeInPrevStageMs !== null) {
                await this._checkStageDelay(accountId, attemptId, prevStage, timeInPrevStageMs, isUnexpected);
            }

        } catch (err) {
            console.warn(`[CycleAnalyzer] onStageChange error for ${accountId}:`, err.message);
        }
    }

    /**
     * ربط attemptId بحساب (يُستدعى عند بدء محاولة جديدة)
     */
    bindAttempt(accountId, attemptId, connectionType = 'qr_code') {
        const existing = this._activeStages.get(accountId);
        this._activeStages.set(accountId, {
            stage:          existing?.stage || STAGES.INITIALIZING,
            enteredAt:      existing?.enteredAt || Date.now(),
            attemptId,
            connectionType,
        });
    }

    /**
     * انهاء دورة الاتصال (عند الاتصال أو الانقطاع أو الخطأ)
     */
    async endCycle(accountId, finalStage, reason = null) {
        try {
            const active = this._activeStages.get(accountId);
            if (!active || !active.attemptId) return;

            const duration = Date.now() - active.enteredAt;

            // تسجيل الانتقال النهائي إذا لزم
            if (active.stage !== finalStage) {
                await this.onStageChange(accountId, finalStage, {
                    reason,
                    attemptId:      active.attemptId,
                    connectionType: active.connectionType,
                });
            }

            // تحديث جدول المحاولات بمرحلة الفشل الدقيقة
            if (finalStage !== STAGES.CONNECTED && active.attemptId) {
                await query(`
                    UPDATE connection_attempts
                    SET failure_stage = $1
                    WHERE id = $2 AND (failure_stage IS NULL OR failure_stage = '')
                `, [active.stage, active.attemptId]).catch(() => {});
            }

            this._activeStages.delete(accountId);
        } catch (err) {
            console.warn(`[CycleAnalyzer] endCycle error for ${accountId}:`, err.message);
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تحليل التأخير
    // ══════════════════════════════════════════════════════════════════════════

    async _checkStageDelay(accountId, attemptId, stage, durationMs, wasUnexpected) {
        const threshold = STAGE_THRESHOLDS[stage];
        if (!threshold) return;

        let anomalyType = null;
        if (durationMs >= threshold.criticalMs) anomalyType = 'critical_delay';
        else if (durationMs >= threshold.warnMs) anomalyType = 'warning_delay';
        else if (wasUnexpected)                  anomalyType = 'unexpected_transition';

        if (!anomalyType) return;

        await query(`
            INSERT INTO cycle_anomalies (
                id, account_id, attempt_id,
                anomaly_type, stage,
                duration_ms, threshold_warn_ms, threshold_critical_ms,
                severity, message, created_at
            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())
        `, [
            crypto.randomUUID(),
            accountId,
            attemptId,
            anomalyType,
            stage,
            durationMs,
            threshold.warnMs,
            threshold.criticalMs,
            anomalyType === 'critical_delay' ? 'critical' : 'warning',
            this._buildAnomalyMessage(anomalyType, stage, durationMs, threshold),
        ]).catch(err => console.warn('[CycleAnalyzer] insert anomaly error:', err.message));
    }

    _buildAnomalyMessage(type, stage, durationMs, threshold) {
        const sec = (durationMs / 1000).toFixed(1);
        const msgs = {
            critical_delay:        `تأخر حرج في مرحلة "${stage}": استغرقت ${sec}ث (الحد الأقصى: ${threshold.criticalMs/1000}ث)`,
            warning_delay:         `تأخر تحذيري في مرحلة "${stage}": استغرقت ${sec}ث (المتوقع: < ${threshold.warnMs/1000}ث)`,
            unexpected_transition: `انتقال غير متوقع من "${stage}" — قد يدل على حالة خطأ صامتة`,
        };
        return msgs[type] || `شذوذ في مرحلة "${stage}"`;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تحليل الدورة الكاملة
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * جلب كامل دورة الاتصال لمحاولة معينة
     * يُرجع Timeline + مقارنة مع النمط المثالي + الشذوذات
     */
    async getCycleAnalysis(accountId, attemptId) {
        const [transitions, anomalies, attempt] = await Promise.all([
            queryAll(`
                SELECT * FROM connection_stage_transitions
                WHERE account_id = $1 AND attempt_id = $2
                ORDER BY transition_at ASC
            `, [accountId, attemptId]),
            queryAll(`
                SELECT * FROM cycle_anomalies
                WHERE account_id = $1 AND attempt_id = $2
                ORDER BY created_at ASC
            `, [accountId, attemptId]),
            queryOne(`
                SELECT * FROM connection_attempts WHERE id = $1
            `, [attemptId]),
        ]);

        if (!transitions.length) return null;

        const connType   = attempt?.connection_type || 'qr_code';
        const idealPath  = EXPECTED_TRANSITIONS[connType] || EXPECTED_TRANSITIONS.qr_code;
        const actualPath = transitions.map(t => t.to_stage).filter(Boolean);

        // ── بناء State Machine Map ─────────────────────────────────────────
        const stageMap = this._buildStageMap(transitions);

        // ── مقارنة مع النمط المثالي ────────────────────────────────────────
        const comparison = this._compareWithIdeal(actualPath, idealPath, stageMap);

        // ── تحديد مرحلة الفشل الدقيقة ─────────────────────────────────────
        const failureAnalysis = this._analyzeFailure(transitions, attempt);

        // ── إجمالي الوقت لكل مرحلة ────────────────────────────────────────
        const stageDurations = this._calcStageDurations(transitions);

        // ── تحليل التقدم ─────────────────────────────────────────────────
        const maxProgress = Math.max(0, ...transitions.map(t => t.progress_pct || 0));

        return {
            attemptId,
            accountId,
            connectionType:  connType,
            outcome:         attempt?.outcome || 'unknown',
            totalDurationMs: attempt?.duration_ms || null,
            maxProgressPct:  maxProgress,

            // المسارات
            idealPath,
            actualPath,

            // خريطة الحالات
            stageMap,

            // المدد
            stageDurations,

            // المقارنة مع المثالي
            comparison,

            // تحليل الفشل
            failureAnalysis,

            // الشذوذات
            anomalies: anomalies.map(a => ({
                type:        a.anomaly_type,
                stage:       a.stage,
                durationMs:  a.duration_ms,
                severity:    a.severity,
                message:     a.message,
                detectedAt:  a.created_at,
            })),

            // عدد الانتقالات غير المتوقعة
            unexpectedTransitionsCount: transitions.filter(t => t.is_unexpected).length,

            // الانتقالات الكاملة
            transitions: transitions.map(t => ({
                fromStage:       t.from_stage,
                toStage:         t.to_stage,
                durationInPrevMs: t.from_stage_duration_ms,
                transitionAt:    t.transition_at,
                isUnexpected:    t.is_unexpected,
                progressPct:     t.progress_pct,
            })),
        };
    }

    /**
     * بناء خريطة الحالات: كل مرحلة → { enteredAt, exitedAt, durationMs, count }
     */
    _buildStageMap(transitions) {
        const map = {};
        for (const t of transitions) {
            const s = t.to_stage;
            if (!s) continue;
            if (!map[s]) {
                map[s] = { enteredAt: t.transition_at, exitedAt: null, durationMs: null, count: 0 };
            }
            map[s].count++;
            map[s].enteredAt = t.transition_at; // آخر دخول

            // تحديث وقت الخروج من المرحلة السابقة
            if (t.from_stage && map[t.from_stage]) {
                map[t.from_stage].exitedAt  = t.transition_at;
                map[t.from_stage].durationMs = t.from_stage_duration_ms;
            }
        }
        return map;
    }

    /**
     * حساب مدة كل مرحلة
     */
    _calcStageDurations(transitions) {
        const durations = {};
        for (const t of transitions) {
            if (t.from_stage && t.from_stage_duration_ms !== null) {
                if (!durations[t.from_stage]) durations[t.from_stage] = 0;
                durations[t.from_stage] += t.from_stage_duration_ms;
            }
        }
        return Object.entries(durations).map(([stage, ms]) => ({
            stage,
            durationMs:  ms,
            durationSec: (ms / 1000).toFixed(2),
            threshold:   STAGE_THRESHOLDS[stage] || null,
            status:      this._getDurationStatus(stage, ms),
        }));
    }

    _getDurationStatus(stage, ms) {
        const th = STAGE_THRESHOLDS[stage];
        if (!th) return 'normal';
        if (ms >= th.criticalMs) return 'critical';
        if (ms >= th.warnMs)     return 'warning';
        return 'normal';
    }

    /**
     * مقارنة المسار الفعلي مع المثالي
     */
    _compareWithIdeal(actualPath, idealPath, stageMap) {
        const missingStages = idealPath.filter(s => !actualPath.includes(s));
        const extraStages   = actualPath.filter(s => !idealPath.includes(s) &&
                                                     s !== STAGES.DISCONNECTED &&
                                                     s !== STAGES.ERROR);
        const completedPct  = idealPath.length > 0
            ? Math.round((idealPath.filter(s => actualPath.includes(s)).length / idealPath.length) * 100)
            : 0;

        // التحقق من الترتيب الصحيح
        let outOfOrder = false;
        const actualIdealOnly = actualPath.filter(s => idealPath.includes(s));
        for (let i = 1; i < actualIdealOnly.length; i++) {
            if (idealPath.indexOf(actualIdealOnly[i]) < idealPath.indexOf(actualIdealOnly[i - 1])) {
                outOfOrder = true;
                break;
            }
        }

        return {
            completedPct,
            missingStages,
            extraStages,
            outOfOrder,
            verdict: this._buildVerdict(completedPct, missingStages, extraStages, outOfOrder),
        };
    }

    _buildVerdict(pct, missing, extra, outOfOrder) {
        if (pct === 100 && !outOfOrder && !extra.length) return 'ideal';
        if (pct >= 80 && !outOfOrder) return 'near_ideal';
        if (outOfOrder) return 'disordered';
        if (extra.length)  return 'has_detours';
        return 'incomplete';
    }

    /**
     * تحليل الفشل: تحديد المرحلة الدقيقة والسبب المحتمل
     */
    _analyzeFailure(transitions, attempt) {
        if (attempt?.outcome === 'connected') {
            return { failed: false, message: 'اتصال ناجح — لا يوجد فشل' };
        }

        const lastTransition = transitions[transitions.length - 1];
        if (!lastTransition) return { failed: true, stage: 'unknown', message: 'لا توجد بيانات كافية' };

        const failedAt = lastTransition.to_stage;
        const failedIn = lastTransition.from_stage;

        const stageMessages = {
            [STAGES.INITIALIZING]:       'فشل في مرحلة التهيئة — مشكلة في إعداد Socket أو قاعدة البيانات',
            [STAGES.QR_GENERATING]:      'تأخر أو فشل في توليد رمز QR — تحقق من اتصال Baileys بخوادم واتساب',
            [STAGES.QR_READY]:           'انتهت مهلة QR قبل مسحه — لم يمسح المستخدم الكود في الوقت المحدد',
            [STAGES.SCANNING]:           'فشل في مرحلة المسح — مشكلة في التحقق من رمز QR',
            [STAGES.CONNECTING]:         'فشل مصافحة واتساب — خطأ في الجلسة أو بيانات الاعتماد',
            [STAGES.PAIRING_STARTING]:   'فشل في بدء عملية Pairing — تحقق من رقم الهاتف',
            [STAGES.PAIRING_GENERATING]: 'فشل في إنشاء Pairing Code — رفض واتساب الطلب',
            [STAGES.PAIRING_READY]:      'انتهت مهلة Pairing — لم يدخل المستخدم الكود في الوقت المحدد',
        };

        const failureStage   = failedIn || failedAt;
        const failureMessage = stageMessages[failureStage] || `فشل في مرحلة "${failureStage}"`;

        return {
            failed:        true,
            stage:         failureStage,
            transitionTo:  failedAt,
            message:       failureMessage,
            failureReason: attempt?.failure_reason || null,
            outcome:       attempt?.outcome || 'failed',
        };
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تقارير متقدمة
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * آخر N دورة لحساب معين مع ملخص سريع
     */
    async getRecentCycles(accountId, limit = 10) {
        const attempts = await queryAll(`
            SELECT ca.*, 
                   COUNT(cst.id) FILTER (WHERE cst.is_unexpected) as unexpected_count,
                   COUNT(cya.id)                                   as anomaly_count,
                   MAX(cst.progress_pct)                           as max_progress
            FROM connection_attempts ca
            LEFT JOIN connection_stage_transitions cst ON cst.attempt_id = ca.id
            LEFT JOIN cycle_anomalies cya              ON cya.attempt_id = ca.id
            WHERE ca.account_id = $1
            GROUP BY ca.id
            ORDER BY ca.started_at DESC
            LIMIT $2
        `, [accountId, limit]);

        return attempts.map(a => ({
            attemptId:        a.id,
            connectionType:   a.connection_type,
            outcome:          a.outcome,
            startedAt:        a.started_at,
            endedAt:          a.ended_at,
            durationMs:       a.duration_ms,
            failureStage:     a.failure_stage,
            maxProgressPct:   parseInt(a.max_progress || 0),
            unexpectedCount:  parseInt(a.unexpected_count || 0),
            anomalyCount:     parseInt(a.anomaly_count || 0),
        }));
    }

    /**
     * إحصائيات الدورات: معدل الوصول لكل مرحلة، متوسط المدة في كل مرحلة
     */
    async getCycleStats(accountId, days = 7) {
        const since = new Date(Date.now() - days * 86_400_000);

        const [stageStats, anomalyStats, outcomeStats] = await Promise.all([
            // إحصائيات كل مرحلة
            queryAll(`
                SELECT
                    to_stage                            as stage,
                    COUNT(*)                            as reach_count,
                    AVG(from_stage_duration_ms)         as avg_prev_duration_ms,
                    MAX(from_stage_duration_ms)         as max_prev_duration_ms,
                    COUNT(*) FILTER (WHERE is_unexpected) as unexpected_count
                FROM connection_stage_transitions
                WHERE account_id = $1
                  AND transition_at >= $2
                GROUP BY to_stage
                ORDER BY reach_count DESC
            `, [accountId, since]),

            // إحصائيات الشذوذات
            queryAll(`
                SELECT
                    anomaly_type,
                    stage,
                    COUNT(*)         as count,
                    AVG(duration_ms) as avg_duration_ms,
                    severity
                FROM cycle_anomalies
                WHERE account_id = $1
                  AND created_at >= $2
                GROUP BY anomaly_type, stage, severity
                ORDER BY count DESC
            `, [accountId, since]),

            // توزيع النتائج
            queryAll(`
                SELECT outcome, COUNT(*) as count
                FROM connection_attempts
                WHERE account_id = $1 AND started_at >= $2
                GROUP BY outcome
                ORDER BY count DESC
            `, [accountId, since]),
        ]);

        // أكثر مرحلة يحدث فيها الفشل
        const failureStages = await queryAll(`
            SELECT failure_stage, COUNT(*) as count
            FROM connection_attempts
            WHERE account_id = $1
              AND started_at >= $2
              AND outcome NOT IN ('connected', 'in_progress')
              AND failure_stage IS NOT NULL
            GROUP BY failure_stage
            ORDER BY count DESC
            LIMIT 5
        `, [accountId, since]);

        return {
            period:       `${days} أيام`,
            stageStats:   stageStats.map(s => ({
                stage:            s.stage,
                reachCount:       parseInt(s.reach_count),
                avgPrevDurationMs: s.avg_prev_duration_ms ? Math.round(s.avg_prev_duration_ms) : null,
                maxPrevDurationMs: s.max_prev_duration_ms ? Math.round(s.max_prev_duration_ms) : null,
                unexpectedCount:  parseInt(s.unexpected_count || 0),
                threshold:        STAGE_THRESHOLDS[s.stage] || null,
            })),
            anomalyStats,
            outcomeStats: outcomeStats.map(o => ({
                outcome: o.outcome,
                count:   parseInt(o.count),
            })),
            topFailureStages: failureStages.map(f => ({
                stage: f.failure_stage,
                count: parseInt(f.count),
            })),
        };
    }

    /**
     * مقارنة الدورة الفعلية مع النمط المثالي — تقرير نصي
     */
    async getCycleSummaryReport(accountId, attemptId) {
        const analysis = await this.getCycleAnalysis(accountId, attemptId);
        if (!analysis) return null;

        const lines = [
            `═══ تقرير دورة الاتصال — المحاولة ${attemptId.slice(0, 8)} ═══`,
            `الحساب: ${accountId}`,
            `نوع الاتصال: ${analysis.connectionType}`,
            `النتيجة: ${analysis.outcome}`,
            `التقدم الأقصى: ${analysis.maxProgressPct}%`,
            ``,
            `── المسار الفعلي ──`,
            analysis.actualPath.join(' → '),
            ``,
            `── المسار المثالي ──`,
            analysis.idealPath.join(' → '),
            ``,
            `── مقارنة الأداء ──`,
            `اكتمال المسار: ${analysis.comparison.completedPct}%`,
            `الحكم: ${analysis.comparison.verdict}`,
        ];

        if (analysis.comparison.missingStages.length) {
            lines.push(`مراحل غائبة: ${analysis.comparison.missingStages.join(', ')}`);
        }
        if (analysis.comparison.extraStages.length) {
            lines.push(`انحرافات: ${analysis.comparison.extraStages.join(', ')}`);
        }
        if (analysis.unexpectedTransitionsCount > 0) {
            lines.push(`انتقالات غير متوقعة: ${analysis.unexpectedTransitionsCount}`);
        }

        lines.push(``, `── تفاصيل المدة لكل مرحلة ──`);
        for (const d of analysis.stageDurations) {
            const statusIcon = { normal: '✅', warning: '⚠️', critical: '🔴' }[d.status] || '—';
            lines.push(`${statusIcon} ${d.stage}: ${d.durationSec}ث`);
        }

        if (analysis.anomalies.length) {
            lines.push(``, `── الشذوذات المكتشفة (${analysis.anomalies.length}) ──`);
            for (const a of analysis.anomalies) {
                const icon = a.severity === 'critical' ? '🚨' : '⚠️';
                lines.push(`${icon} ${a.message}`);
            }
        }

        if (!analysis.failureAnalysis.failed) {
            lines.push(``, `✅ اتصال ناجح بدون مشاكل`);
        } else {
            lines.push(``, `── تحليل الفشل ──`);
            lines.push(`مرحلة الفشل: ${analysis.failureAnalysis.stage}`);
            lines.push(`السبب: ${analysis.failureAnalysis.message}`);
        }

        return lines.join('\n');
    }

    /**
     * إحصائيات Admin على مستوى النظام كله
     */
    async getSystemCycleStats(hours = 24) {
        const since = new Date(Date.now() - hours * 3_600_000);

        const [totalAttempts, anomalyCount, worstStages, accountsWithAnomalies] = await Promise.all([
            queryOne(`
                SELECT COUNT(*) as total,
                       COUNT(*) FILTER (WHERE outcome = 'connected') as successful,
                       AVG(duration_ms) FILTER (WHERE outcome = 'connected') as avg_connect_ms
                FROM connection_attempts
                WHERE started_at >= $1
            `, [since]),
            queryOne(`SELECT COUNT(*) as cnt FROM cycle_anomalies WHERE created_at >= $1`, [since]),
            queryAll(`
                SELECT stage, anomaly_type, COUNT(*) as count
                FROM cycle_anomalies
                WHERE created_at >= $1
                GROUP BY stage, anomaly_type
                ORDER BY count DESC
                LIMIT 10
            `, [since]),
            queryAll(`
                SELECT account_id, COUNT(*) as anomaly_count
                FROM cycle_anomalies
                WHERE created_at >= $1
                GROUP BY account_id
                ORDER BY anomaly_count DESC
                LIMIT 10
            `, [since]),
        ]);

        const total   = parseInt(totalAttempts?.total || 0);
        const success = parseInt(totalAttempts?.successful || 0);

        return {
            period:          `${hours} ساعة`,
            totalAttempts:   total,
            successfulConns: success,
            successRate:     total > 0 ? Math.round((success / total) * 100) : 0,
            avgConnectMs:    totalAttempts?.avg_connect_ms ? Math.round(totalAttempts.avg_connect_ms) : null,
            totalAnomalies:  parseInt(anomalyCount?.cnt || 0),
            worstStages,
            accountsWithAnomalies,
        };
    }
}

module.exports = new ConnectionCycleAnalyzer();
module.exports.STAGES = STAGES;
module.exports.STAGE_THRESHOLDS = STAGE_THRESHOLDS;
module.exports.EXPECTED_TRANSITIONS = EXPECTED_TRANSITIONS;
