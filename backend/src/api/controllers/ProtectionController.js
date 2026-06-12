'use strict';
/**
 * ProtectionController — واجهة API لنظام الحماية
 */
const { ProtectionService, SecurityLogger, DEFAULT_CONFIG } = require('../services/ProtectionService');
const { getPool } = require('../../lib/postgres');

const svc = ProtectionService.getInstance();

class ProtectionController {

    // ─── GET /protection/config ─────────────────────────────────────────────
    async getConfig(req, res) {
        try {
            const userId = req.user.id;
            const cfg    = await svc.loadConfig(userId);
            res.json({ success: true, config: cfg });
        } catch (err) {
            console.error('[ProtectionController.getConfig]', err);
            res.status(500).json({ success: false, error: 'فشل في جلب إعدادات الحماية' });
        }
    }

    // ─── PUT /protection/config ─────────────────────────────────────────────
    async updateConfig(req, res) {
        try {
            const userId  = req.user.id;
            const allowed = [
                'max_ops_per_hour', 'max_ops_per_day',
                'min_delay_between_ops', 'max_delay_between_ops',
                'distribution_mode', 'error_threshold',
                'auto_disable_on_error', 'retry_enabled',
                'max_retries', 'retry_base_delay', 'retry_max_delay',
                'log_retention_days', 'is_active',
            ];
            const updates = {};
            for (const key of allowed) {
                if (req.body[key] !== undefined) updates[key] = req.body[key];
            }
            const cfg = await svc.saveConfig(userId, updates);
            res.json({ success: true, config: cfg, message: 'تم حفظ إعدادات الحماية' });
        } catch (err) {
            console.error('[ProtectionController.updateConfig]', err);
            res.status(500).json({ success: false, error: 'فشل في حفظ إعدادات الحماية' });
        }
    }

    // ─── POST /protection/config/reset ─────────────────────────────────────
    async resetConfig(req, res) {
        try {
            const userId = req.user.id;
            const cfg    = await svc.saveConfig(userId, { ...DEFAULT_CONFIG });
            res.json({ success: true, config: cfg, message: 'تم إعادة ضبط إعدادات الحماية للافتراضية' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'فشل في إعادة الضبط' });
        }
    }

    // ─── GET /protection/stats ──────────────────────────────────────────────
    async getStats(req, res) {
        try {
            const userId = req.user.id;

            // جلب حسابات المستخدم
            const pool = getPool();
            const { rows: accounts } = await pool.query(
                `SELECT a.id, a.phone_number, a.name, a.status,
                        COALESCE(pas.is_suspended, false) as is_suspended
                 FROM accounts a
                 LEFT JOIN protection_account_state pas ON a.id = pas.account_id
                 WHERE a.user_id = $1`,
                [userId]
            );

            const stats = await svc.getStats(userId, accounts);
            res.json({ success: true, ...stats });
        } catch (err) {
            console.error('[ProtectionController.getStats]', err);
            res.status(500).json({ success: false, error: 'فشل في جلب الإحصائيات' });
        }
    }

    // ─── POST /protection/accounts/:accountId/suspend ──────────────────────
    async suspendAccount(req, res) {
        try {
            const userId    = req.user.id;
            const accountId = req.params.accountId;
            await svc.suspendAccount(userId, accountId, req.body.reason || 'manual');
            res.json({ success: true, message: 'تم إيقاف الحساب مؤقتاً' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'فشل في إيقاف الحساب' });
        }
    }

    // ─── POST /protection/accounts/:accountId/resume ───────────────────────
    async resumeAccount(req, res) {
        try {
            const userId    = req.user.id;
            const accountId = req.params.accountId;
            await svc.resumeAccount(userId, accountId);
            res.json({ success: true, message: 'تم استئناف تشغيل الحساب' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'فشل في استئناف الحساب' });
        }
    }

    // ─── GET /protection/logs ───────────────────────────────────────────────
    async getLogs(req, res) {
        try {
            const userId = req.user.id;
            const { accountId, eventType, from, to, limit = 100, offset = 0 } = req.query;
            const result = await SecurityLogger.fetch(userId, {
                accountId, eventType, from, to,
                limit:  parseInt(limit),
                offset: parseInt(offset),
            });
            res.json({ success: true, ...result });
        } catch (err) {
            console.error('[ProtectionController.getLogs]', err);
            res.status(500).json({ success: false, error: 'فشل في جلب السجل الأمني' });
        }
    }

    // ─── GET /protection/logs/summary ──────────────────────────────────────
    async getLogsSummary(req, res) {
        try {
            const userId = req.user.id;
            const pool   = getPool();

            const { rows } = await pool.query(
                `SELECT
                    event_type,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')   as last_hour,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')  as last_day,
                    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')    as last_week,
                    MAX(created_at) as last_at
                 FROM protection_security_logs
                 WHERE user_id = $1
                 GROUP BY event_type`,
                [userId]
            );

            // إحصاء الحسابات الموقوفة
            const { rows: suspended } = await pool.query(
                `SELECT COUNT(*) as cnt
                 FROM protection_account_state pas
                 JOIN accounts a ON a.id = pas.account_id
                 WHERE a.user_id = $1 AND pas.is_suspended = true`,
                [userId]
            );

            res.json({
                success: true,
                summary: rows,
                suspendedAccounts: parseInt(suspended[0]?.cnt || 0),
            });
        } catch (err) {
            res.status(500).json({ success: false, error: 'فشل في جلب ملخص السجل' });
        }
    }

    // ─── DELETE /protection/logs ────────────────────────────────────────────
    async clearLogs(req, res) {
        try {
            const userId = req.user.id;
            const deleted = await svc.cleanOldLogs(userId);
            res.json({ success: true, deleted, message: `تم حذف ${deleted} سجل قديم` });
        } catch (err) {
            res.status(500).json({ success: false, error: 'فشل في تنظيف السجلات' });
        }
    }

    // ─── GET /protection/accounts/state ────────────────────────────────────
    async getAccountsState(req, res) {
        try {
            const userId = req.user.id;
            const pool   = getPool();
            const { rows } = await pool.query(
                `SELECT a.id, a.phone_number, a.name, a.status,
                        COALESCE(pas.is_suspended, false)  as is_suspended,
                        pas.suspended_at,
                        (SELECT COUNT(*) FROM protection_security_logs l
                         WHERE l.account_id = a.id AND l.user_id = $1
                           AND l.event_type IN ('error','join_failed')
                           AND l.created_at > NOW() - INTERVAL '1 hour') as recent_errors
                 FROM accounts a
                 LEFT JOIN protection_account_state pas ON a.id = pas.account_id
                 WHERE a.user_id = $1
                 ORDER BY a.created_at`,
                [userId]
            );
            res.json({ success: true, accounts: rows });
        } catch (err) {
            res.status(500).json({ success: false, error: 'فشل في جلب حالة الحسابات' });
        }
    }
}

module.exports = new ProtectionController();

