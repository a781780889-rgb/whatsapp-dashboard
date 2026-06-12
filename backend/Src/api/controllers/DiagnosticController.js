'use strict';
/**
 * DiagnosticController.js — واجهة API لنظام التشخيص
 *
 * Endpoints:
 *   GET  /accounts/:id/diagnostics          → آخر تشخيص للحساب
 *   GET  /accounts/:id/diagnostics/history  → سجل التشخيصات
 *   POST /accounts/:id/diagnostics/scan     → تشخيص فوري كامل
 *   GET  /admin/diagnostics                 → جميع التشخيصات (admin)
 */

const DiagnosticEngine  = require('../services/DiagnosticEngine');
const DatabaseManager   = require('../../database/DatabaseManager');

class DiagnosticController {

    // ── آخر تشخيص للحساب ─────────────────────────────────────────────────
    async getLastDiagnostic(req, res) {
        try {
            const { id } = req.params;

            const account = await DatabaseManager.systemDB.get(
                `SELECT id, name, status, health_status, connection_type FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });

            const last = await DiagnosticEngine.getLastDiagnostic(id);

            return res.json({
                success: true,
                account: {
                    id:             account.id,
                    name:           account.name,
                    status:         account.status,
                    health_status:  account.health_status,
                    connection_type: account.connection_type,
                },
                diagnostic: last || null,
                hasData: !!last,
            });
        } catch (err) {
            console.error('[DiagnosticController.getLastDiagnostic]', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام التشخيص.' });
        }
    }

    // ── سجل التشخيصات ────────────────────────────────────────────────────
    async getDiagnosticHistory(req, res) {
        try {
            const { id }     = req.params;
            const limit      = Math.min(parseInt(req.query.limit || '20'), 100);

            const history = await DiagnosticEngine.getDiagnosticHistory(id, limit);

            return res.json({
                success: true,
                accountId: id,
                total:    history.length,
                history,
            });
        } catch (err) {
            console.error('[DiagnosticController.getDiagnosticHistory]', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام التشخيص.' });
        }
    }

    // ── تشخيص فوري كامل (Full Scan) ──────────────────────────────────────
    async runFullScan(req, res) {
        try {
            const { id } = req.params;

            const account = await DatabaseManager.systemDB.get(
                `SELECT id, name, status, health_status FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود.' });

            const result = await DiagnosticEngine.runFullDiagnostic(id);

            // إعداد التقرير النهائي المنسَّق
            const report = _formatDiagnosticReport(account, result);

            return res.json({
                success: true,
                report,
                rawResult: result,
            });
        } catch (err) {
            console.error('[DiagnosticController.runFullScan]', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام التشخيص.' });
        }
    }

    // ── قائمة جميع تشخيصات النظام (admin) ────────────────────────────────
    async getAllDiagnostics(req, res) {
        try {
            const { page = 1, limit = 50, category, accountId } = req.query;
            const offset = (Number(page) - 1) * Number(limit);

            let where = 'WHERE 1=1';
            const params = [];
            if (category)  { where += ` AND category = $${params.length+1}`;    params.push(category); }
            if (accountId) { where += ` AND account_id = $${params.length+1}`;  params.push(accountId); }

            const { queryAll: dbQueryAll, queryOne: dbQueryOne } = require('../../lib/postgres');

            const rows = await dbQueryAll(
                `SELECT cd.*, a.name as account_name
                 FROM connection_diagnostics cd
                 LEFT JOIN accounts a ON a.id = cd.account_id
                 ${where}
                 ORDER BY cd.created_at DESC
                 LIMIT $${params.length+1} OFFSET $${params.length+2}`,
                [...params, Number(limit), offset]
            );
            const countRow = await dbQueryOne(
                `SELECT COUNT(*) as cnt FROM connection_diagnostics ${where}`,
                params
            );

            return res.json({
                success:     true,
                diagnostics: rows || [],
                total:       parseInt(countRow?.cnt || 0),
                page:        Number(page),
                limit:       Number(limit),
            });
        } catch (err) {
            console.error('[DiagnosticController.getAllDiagnostics]', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام التشخيص.' });
        }
    }

    // ── إحصائيات التشخيصات (admin) ────────────────────────────────────────
    async getDiagnosticStats(req, res) {
        try {
            const { queryAll: dbQueryAll } = require('../../lib/postgres');

            const [categoryStats, dailyStats] = await Promise.all([
                dbQueryAll(`
                    SELECT category, COUNT(*) as count,
                           AVG(confidence_score) as avg_confidence
                    FROM connection_diagnostics
                    WHERE created_at > NOW() - INTERVAL '7 days'
                    GROUP BY category
                    ORDER BY count DESC
                `),
                dbQueryAll(`
                    SELECT DATE(created_at) as date, COUNT(*) as total,
                           SUM(CASE WHEN diagnostic_type = 'connection_failure' THEN 1 ELSE 0 END) as failures,
                           SUM(CASE WHEN diagnostic_type = 'connection_success' THEN 1 ELSE 0 END) as successes
                    FROM connection_diagnostics
                    WHERE created_at > NOW() - INTERVAL '7 days'
                    GROUP BY DATE(created_at)
                    ORDER BY date DESC
                `),
            ]);

            return res.json({
                success: true,
                stats: {
                    byCategory: categoryStats || [],
                    daily:      dailyStats    || [],
                },
            });
        } catch (err) {
            console.error('[DiagnosticController.getDiagnosticStats]', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في نظام التشخيص.' });
        }
    }
}

// ── تنسيق التقرير النهائي ─────────────────────────────────────────────────
function _formatDiagnosticReport(account, result) {
    const last = result.lastFailure;
    const infra = result.infrastructure;

    // تحديد المشكلة الرئيسية
    let mainIssue = null;

    if (!infra.database.healthy) {
        mainIssue = {
            emoji:       '🔴',
            category:    'Database_Failure',
            confidence:  95,
            stage:       'loading_session',
            rootCause:   `قاعدة البيانات PostgreSQL غير متاحة: ${infra.database.error}`,
            evidence:    'فشل الاتصال بـ PostgreSQL عند بدء التشغيل.',
            fix:         'تحقق من DATABASE_URL في Railway وتأكد من تشغيل PostgreSQL.',
        };
    } else if (!infra.redis.healthy) {
        mainIssue = {
            emoji:       '🟠',
            category:    'Redis_Failure',
            confidence:  90,
            stage:       'connecting',
            rootCause:   `Redis غير متاح: ${infra.redis.error}`,
            evidence:    'فشل الاتصال بـ Redis — يؤثر على Rate Limiting.',
            fix:         'تحقق من REDIS_URL في Railway.',
        };
    } else if (!infra.sessionExists) {
        mainIssue = {
            emoji:       '🟡',
            category:    'Session_Expired',
            confidence:  95,
            stage:       'loading_session',
            rootCause:   'لا توجد جلسة واتساب مرتبطة بهذا الحساب.',
            evidence:    'session_data.creds فارغة في قاعدة البيانات.',
            fix:         'اربط الحساب بـ QR Code أو Pairing Code.',
        };
    } else if (last && last.diagnostic_type === 'connection_failure') {
        mainIssue = {
            emoji:       '❌',
            category:    last.category,
            confidence:  last.confidence_score,
            stage:       last.failure_stage,
            rootCause:   last.root_cause,
            evidence:    last.evidence,
            fix:         last.recommended_fix,
        };
    }

    return {
        account: {
            id:     account.id,
            name:   account.name,
            status: account.status,
        },
        timestamp:       result.timestamp,
        mainIssue,
        infrastructure:  {
            database:    infra.database.healthy  ? '✅ متصل' : `❌ ${infra.database.error}`,
            redis:       infra.redis.healthy     ? '✅ متصل' : `❌ ${infra.redis.error}`,
            session:     infra.sessionExists     ? '✅ موجودة' : '⚠️ غير موجودة',
        },
        sessionDetails:  result.sessionAnalysis,
        recommendations: result.recommendations,
    };
}

module.exports = new DiagnosticController();

