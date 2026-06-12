'use strict';
/**
 * DiagnosticEngine.js — نظام التشخيص الاحترافي للاتصال بواتساب
 *
 * يُحلِّل سبب فشل الاتصال بدقة ويُصدر تقريراً مدعوماً بأدلة تقنية.
 *
 * التصنيفات المدعومة (17 تصنيفاً):
 *   Authentication_Failure | Authorization_Failure | Session_Corruption
 *   Session_Expired | Session_Logged_Out | Session_Replaced
 *   QR_Failure | Pairing_Failure | Database_Failure | Redis_Failure
 *   Queue_Failure | Socket_Failure | Baileys_Failure | WhatsApp_Restriction
 *   Network_Failure | Infrastructure_Failure | Configuration_Failure | Unknown_Failure
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const { getRedis }                   = require('../../lib/redis');

// ── مراحل الاتصال المعروفة ─────────────────────────────────────────────────
const CONNECTION_STAGES = [
    'initializing',
    'loading_session',
    'restoring_credentials',
    'qr_generating',
    'qr_ready',
    'pairing_starting',
    'pairing_generating',
    'pairing_ready',
    'connecting',
    'authenticating',
    'syncing',
    'connected',
    'disconnected',
    'error',
];

// ── خريطة أكواد Baileys → تشخيص ──────────────────────────────────────────
const DISCONNECT_CODE_MAP = {
    401: {
        category:       'Session_Logged_Out',
        failureStage:   'authentication',
        rootCause:      'تم تسجيل خروج الحساب من تطبيق واتساب يدوياً أو من جهاز آخر.',
        evidence:       'DisconnectReason.loggedOut (401) — أرسل واتساب إشارة تسجيل خروج.',
        recommendedFix: 'حذف الجلسة الحالية وإعادة الربط باستخدام QR Code أو Pairing Code.',
        confidence:     100,
    },
    440: {
        category:       'Session_Replaced',
        failureStage:   'authentication',
        rootCause:      'تم فتح الجلسة ذاتها في جهاز أو متصفح آخر مما أدى إلى استبدال الجلسة الحالية.',
        evidence:       'DisconnectReason.connectionReplaced (440) — واتساب يرفض أكثر من جلسة نشطة.',
        recommendedFix: 'أغلق جميع جلسات واتساب Web النشطة من هاتفك، ثم أعد الاتصال.',
        confidence:     100,
    },
    500: {
        category:       'Session_Corruption',
        failureStage:   'restoring_credentials',
        rootCause:      'بيانات الجلسة المخزنة في قاعدة البيانات تالفة أو غير صالحة لـ Baileys.',
        evidence:       'DisconnectReason.badSession (500) — فشل Baileys في فك تشفير بيانات الاعتماد.',
        recommendedFix: 'حذف الجلسة تلقائياً وإعادة الربط بـ QR Code جديد.',
        confidence:     95,
    },
    515: {
        category:       'Baileys_Failure',
        failureStage:   'connecting',
        rootCause:      'طلب Baileys إعادة تشغيل الاتصال (restartRequired) — يحدث عادةً بعد مسح QR.',
        evidence:       'DisconnectReason.restartRequired (515) — سلوك طبيعي بعد مسح QR.',
        recommendedFix: 'إعادة الاتصال تلقائياً (يتم ذلك تلقائياً).',
        confidence:     80,
    },
    408: {
        category:       'Network_Failure',
        failureStage:   'connecting',
        rootCause:      'انقطع الاتصال بخوادم واتساب بسبب مهلة الشبكة أو فقدان الاتصال.',
        evidence:       'DisconnectReason.connectionLost/timedOut (408) — Socket مغلق من جانب الخادم.',
        recommendedFix: 'التحقق من استقرار الإنترنت على Railway. يتم إعادة الاتصال تلقائياً.',
        confidence:     85,
    },
    428: {
        category:       'Network_Failure',
        failureStage:   'connecting',
        rootCause:      'أُغلق الاتصال من طرف خوادم واتساب.',
        evidence:       'DisconnectReason.connectionClosed (428) — إغلاق مفاجئ للـ Socket.',
        recommendedFix: 'يتم إعادة الاتصال تلقائياً بعد تأخير تدريجي.',
        confidence:     80,
    },
};

// ── مشكلات خاصة بالسياق ───────────────────────────────────────────────────
const CONTEXT_DIAGNOSTICS = {
    qr_timeout: {
        category:       'QR_Failure',
        failureStage:   'qr_generating',
        rootCause:      'لم يُولِّد Baileys رمز QR خلال 30 ثانية.',
        evidence:       'مهلة QR_GENERATE_TIMEOUT_MS (30000ms) انتهت بدون حدث qr.',
        recommendedFix: 'تحقق من اتصال الإنترنت في بيئة Railway وأعد المحاولة.',
        confidence:     90,
    },
    pairing_timeout: {
        category:       'Pairing_Failure',
        failureStage:   'pairing_generating',
        rootCause:      'لم يصل رمز الإقران خلال 45 ثانية.',
        evidence:       'مهلة PAIRING_TIMEOUT_MS (45000ms) انتهت بدون استجابة واتساب.',
        recommendedFix: 'تحقق من صحة رقم الهاتف (مع رمز الدولة) وأعد المحاولة.',
        confidence:     90,
    },
    pairing_rejected: {
        category:       'Pairing_Failure',
        failureStage:   'pairing_generating',
        rootCause:      'رفض واتساب طلب الإقران — قد يكون رقم الهاتف غير صحيح أو محظور.',
        evidence:       'خطأ في requestPairingCode() من Baileys.',
        recommendedFix: 'تحقق من رقم الهاتف مع رمز الدولة وتأكد أن الحساب غير محظور.',
        confidence:     85,
    },
    no_session_data: {
        category:       'Session_Expired',
        failureStage:   'loading_session',
        rootCause:      'لا توجد بيانات جلسة مخزنة لهذا الحساب — جلسة جديدة مطلوبة.',
        evidence:       'session_data فارغة لهذا account_id في قاعدة البيانات.',
        recommendedFix: 'اربط الحساب بـ QR Code أو Pairing Code.',
        confidence:     95,
    },
    session_corrupted: {
        category:       'Session_Corruption',
        failureStage:   'restoring_credentials',
        rootCause:      'بيانات credentials المخزنة تالفة أو بتنسيق قديم غير متوافق.',
        evidence:       'فشل قراءة/فك تشفير session_data من قاعدة البيانات.',
        recommendedFix: 'حذف الجلسة وإعادة الربط.',
        confidence:     92,
    },
    redis_unavailable: {
        category:       'Redis_Failure',
        failureStage:   'connecting',
        rootCause:      'Redis غير متاح — فشل Rate Limiting ومراقبة الحالة.',
        evidence:       'خطأ اتصال Redis في _checkRateLimit().',
        recommendedFix: 'تحقق من متغير REDIS_URL في إعدادات Railway.',
        confidence:     90,
    },
    db_unavailable: {
        category:       'Database_Failure',
        failureStage:   'loading_session',
        rootCause:      'قاعدة البيانات PostgreSQL غير متاحة أو اتصال مُحال.',
        evidence:       'خطأ في الاتصال بـ PostgreSQL عند محاولة جلب بيانات الجلسة.',
        recommendedFix: 'تحقق من DATABASE_URL في Railway وتأكد من تشغيل PostgreSQL.',
        confidence:     95,
    },
    max_reconnect: {
        category:       'Network_Failure',
        failureStage:   'connecting',
        rootCause:      'وصل عدد محاولات إعادة الاتصال للحد الأقصى بدون نجاح.',
        evidence:       `تجاوز MAX_RECONNECT_ATTEMPTS بدون الوصول لحالة connected.`,
        recommendedFix: 'تحقق من استقرار الشبكة وأعد تشغيل الخادم أو الحساب.',
        confidence:     80,
    },
    whatsapp_restriction: {
        category:       'WhatsApp_Restriction',
        failureStage:   'authentication',
        rootCause:      'قيَّد واتساب الحساب أو أوقفه بسبب نشاط مشبوه أو مخالفة السياسات.',
        evidence:       'رمز خطأ غير معروف من واتساب مع عدم إمكانية الاتصال.',
        recommendedFix: 'راجع حالة الحساب في تطبيق واتساب وتوقف عن أي نشاط آلي مؤقتاً.',
        confidence:     70,
    },
};

class DiagnosticEngine {

    constructor() {
        // سجل داخلي لتتبع مراحل الاتصال قبل الكتابة لقاعدة البيانات
        this._stageLog = new Map(); // accountId → { stage, ts, errors[] }
    }

    // ── تسجيل تغيير المرحلة ────────────────────────────────────────────────
    trackStage(accountId, stage, meta = {}) {
        const existing = this._stageLog.get(accountId) || { stages: [], errors: [] };
        existing.stages.push({ stage, ts: Date.now(), ...meta });
        this._stageLog.set(accountId, existing);
    }

    // ── تسجيل خطأ في سياق الاتصال ────────────────────────────────────────
    trackError(accountId, context, error) {
        const existing = this._stageLog.get(accountId) || { stages: [], errors: [] };
        existing.errors.push({ context, error: error?.message || String(error), ts: Date.now() });
        this._stageLog.set(accountId, existing);
    }

    // ── التشخيص الرئيسي عند فشل الاتصال ─────────────────────────────────
    async diagnose(accountId, {
        disconnectCode,
        contextKey,
        pairingError,
        fromStage,
        extraDetails = {},
    } = {}) {
        try {
            let diag = null;

            // 1. تشخيص بناءً على كود Baileys
            if (disconnectCode && DISCONNECT_CODE_MAP[disconnectCode]) {
                diag = { ...DISCONNECT_CODE_MAP[disconnectCode] };
            }
            // 2. تشخيص بناءً على السياق
            else if (contextKey && CONTEXT_DIAGNOSTICS[contextKey]) {
                diag = { ...CONTEXT_DIAGNOSTICS[contextKey] };
            }
            // 3. تشخيص عند خطأ Pairing
            else if (pairingError) {
                diag = {
                    ...CONTEXT_DIAGNOSTICS.pairing_rejected,
                    rootCause:  `رفض واتساب رمز الإقران: ${pairingError}`,
                    evidence:   `requestPairingCode() → خطأ: ${pairingError}`,
                };
            }
            // 4. تشخيص افتراضي مجهول
            else {
                diag = {
                    category:       'Unknown_Failure',
                    failureStage:   fromStage || 'unknown',
                    rootCause:      'سبب الفشل غير محدد — يحتاج إلى مراجعة السجلات.',
                    evidence:       JSON.stringify(extraDetails),
                    recommendedFix: 'راجع سجلات Railway وأعد المحاولة.',
                    confidence:     40,
                };
            }

            // تحسين السياق بالمراحل المسجَّلة
            const stageData = this._stageLog.get(accountId);
            const technicalDetails = {
                disconnectCode:   disconnectCode || null,
                contextKey:       contextKey || null,
                stageHistory:     stageData?.stages?.slice(-10) || [],
                errorHistory:     stageData?.errors?.slice(-5) || [],
                ...extraDetails,
            };

            // فحص قاعدة البيانات للتحقق من وجود بيانات جلسة
            const sessionExists = await this._checkSessionExists(accountId);
            if (!sessionExists && diag.category === 'Unknown_Failure') {
                diag = { ...CONTEXT_DIAGNOSTICS.no_session_data };
            }

            // حفظ في قاعدة البيانات
            await this._saveDiagnostic(accountId, {
                diagnosticType:  'connection_failure',
                failureStage:    diag.failureStage,
                failureReason:   diag.rootCause,
                technicalDetails,
                rootCause:       diag.rootCause,
                recommendedFix:  diag.recommendedFix,
                confidenceScore: diag.confidence,
                category:        diag.category,
                evidence:        diag.evidence,
            });

            // تنظيف سجل المراحل بعد إصدار التشخيص
            this._stageLog.delete(accountId);

            return diag;
        } catch (err) {
            console.error(`[DiagnosticEngine] diagnose error for ${accountId}:`, err.message);
            return null;
        }
    }

    // ── تشخيص اكتمال الاتصال ─────────────────────────────────────────────
    async diagnoseSuccess(accountId, connectionType = 'qr_code') {
        try {
            await this._saveDiagnostic(accountId, {
                diagnosticType:  'connection_success',
                failureStage:    'connected',
                failureReason:   null,
                technicalDetails: { connectionType },
                rootCause:       null,
                recommendedFix:  null,
                confidenceScore: 100,
                category:        'Connected',
                evidence:        `اتصل الحساب بنجاح عبر ${connectionType}.`,
            });
            this._stageLog.delete(accountId);
        } catch (err) {
            console.error(`[DiagnosticEngine] diagnoseSuccess error:`, err.message);
        }
    }

    // ── فحص وجود بيانات الجلسة ────────────────────────────────────────────
    async _checkSessionExists(accountId) {
        try {
            const row = await queryOne(
                `SELECT 1 FROM session_data WHERE account_id = $1 AND key = 'creds' LIMIT 1`,
                [accountId]
            );
            return !!row;
        } catch {
            return false;
        }
    }

    // ── فحص Redis ────────────────────────────────────────────────────────
    async checkRedisHealth() {
        try {
            const redis = getRedis();
            await redis.ping();
            return { healthy: true, latencyMs: null };
        } catch (err) {
            return { healthy: false, error: err.message };
        }
    }

    // ── فحص قاعدة البيانات ───────────────────────────────────────────────
    async checkDBHealth() {
        try {
            const start = Date.now();
            await queryOne(`SELECT 1`);
            return { healthy: true, latencyMs: Date.now() - start };
        } catch (err) {
            return { healthy: false, error: err.message };
        }
    }

    // ── فحص جميع مكونات البنية التحتية ──────────────────────────────────
    async checkInfrastructure(accountId) {
        const [dbHealth, redisHealth, sessionExists] = await Promise.all([
            this.checkDBHealth(),
            this.checkRedisHealth(),
            this._checkSessionExists(accountId),
        ]);

        const issues = [];
        if (!dbHealth.healthy)    issues.push({ component: 'PostgreSQL', error: dbHealth.error });
        if (!redisHealth.healthy) issues.push({ component: 'Redis',      error: redisHealth.error });

        return {
            database:      dbHealth,
            redis:         redisHealth,
            sessionExists,
            issues,
            allHealthy:    issues.length === 0,
        };
    }

    // ── جلب آخر تشخيص للحساب ────────────────────────────────────────────
    async getLastDiagnostic(accountId) {
        try {
            return await queryOne(
                `SELECT * FROM connection_diagnostics
                 WHERE account_id = $1
                 ORDER BY created_at DESC LIMIT 1`,
                [accountId]
            );
        } catch {
            return null;
        }
    }

    // ── جلب سجل التشخيصات ────────────────────────────────────────────────
    async getDiagnosticHistory(accountId, limit = 20) {
        try {
            return await queryAll(
                `SELECT * FROM connection_diagnostics
                 WHERE account_id = $1
                 ORDER BY created_at DESC LIMIT $2`,
                [accountId, limit]
            );
        } catch {
            return [];
        }
    }

    // ── تشخيص كامل عند الطلب (Full Scan) ────────────────────────────────
    async runFullDiagnostic(accountId) {
        const result = {
            accountId,
            timestamp:         new Date().toISOString(),
            infrastructure:    null,
            sessionAnalysis:   null,
            lastFailure:       null,
            currentState:      null,
            recommendations:   [],
        };

        // 1. فحص البنية التحتية
        result.infrastructure = await this.checkInfrastructure(accountId);

        // 2. تحليل الجلسة
        result.sessionAnalysis = await this._analyzeSession(accountId);

        // 3. آخر تشخيص مسجَّل
        result.lastFailure = await this.getLastDiagnostic(accountId);

        // 4. بناء التوصيات
        if (!result.infrastructure.database.healthy) {
            result.recommendations.push({
                priority: 'critical',
                action:   'إصلاح اتصال PostgreSQL — تحقق من DATABASE_URL في Railway.',
            });
        }
        if (!result.infrastructure.redis.healthy) {
            result.recommendations.push({
                priority: 'high',
                action:   'إصلاح اتصال Redis — تحقق من REDIS_URL في Railway.',
            });
        }
        if (!result.infrastructure.sessionExists) {
            result.recommendations.push({
                priority: 'high',
                action:   'لا توجد جلسة — اربط الحساب بـ QR Code أو Pairing Code.',
            });
        }
        if (result.lastFailure?.category === 'Session_Logged_Out') {
            result.recommendations.push({
                priority: 'high',
                action:   'الحساب سُجِّل خروجه من واتساب — أعد الربط.',
            });
        }
        if (result.lastFailure?.category === 'Session_Corruption') {
            result.recommendations.push({
                priority: 'high',
                action:   'جلسة تالفة — احذف الجلسة وأعد الربط.',
            });
        }

        return result;
    }

    // ── تحليل بيانات الجلسة ─────────────────────────────────────────────
    async _analyzeSession(accountId) {
        try {
            const rows = await queryAll(
                `SELECT key, updated_at FROM session_data WHERE account_id = $1`,
                [accountId]
            );
            if (!rows || rows.length === 0) {
                return { exists: false, keyCount: 0, hasCreds: false, lastUpdated: null };
            }
            const hasCreds = rows.some(r => r.key === 'creds');
            const keyKeys   = rows.filter(r => r.key.startsWith('keys:')).length;
            const lastUp    = rows.reduce((m, r) => {
                const t = new Date(r.updated_at).getTime();
                return t > m ? t : m;
            }, 0);
            return {
                exists:      true,
                keyCount:    rows.length,
                hasCreds,
                signalKeys:  keyKeys,
                lastUpdated: lastUp ? new Date(lastUp).toISOString() : null,
            };
        } catch (err) {
            return { exists: false, error: err.message };
        }
    }

    // ── حفظ التشخيص في قاعدة البيانات ───────────────────────────────────
    async _saveDiagnostic(accountId, {
        diagnosticType, failureStage, failureReason,
        technicalDetails, rootCause, recommendedFix,
        confidenceScore, category, evidence,
    }) {
        try {
            await query(`
                INSERT INTO connection_diagnostics
                    (account_id, diagnostic_type, category, failure_stage, failure_reason,
                     technical_details, root_cause, evidence, recommended_fix, confidence_score)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            `, [
                accountId,
                diagnosticType,
                category,
                failureStage,
                failureReason,
                JSON.stringify(technicalDetails),
                rootCause,
                evidence,
                recommendedFix,
                confidenceScore,
            ]);
        } catch (err) {
            // لا نريد أن يُسبِّب نظام التشخيص أخطاء إضافية
            console.warn(`[DiagnosticEngine] Failed to save diagnostic:`, err.message);
        }
    }

    // ── إرجاع خريطة أكواد الفصل (للـ Controller) ───────────────────────
    getDisconnectCodeMap() {
        return DISCONNECT_CODE_MAP;
    }

    // ── إرجاع قائمة التصنيفات ────────────────────────────────────────────
    getCategories() {
        return [
            'Authentication_Failure', 'Authorization_Failure', 'Session_Corruption',
            'Session_Expired',        'Session_Logged_Out',    'Session_Replaced',
            'QR_Failure',             'Pairing_Failure',       'Database_Failure',
            'Redis_Failure',          'Queue_Failure',         'Socket_Failure',
            'Baileys_Failure',        'WhatsApp_Restriction',  'Network_Failure',
            'Infrastructure_Failure', 'Configuration_Failure', 'Unknown_Failure',
            'Connected',
        ];
    }
}

module.exports = new DiagnosticEngine();
