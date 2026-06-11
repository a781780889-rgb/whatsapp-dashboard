'use strict';
/**
 * RuntimeController.js — المرحلة الثانية: واجهة API لتحليل وقت التشغيل
 *
 * Endpoints:
 *  GET  /accounts/:id/runtime/report       — تقرير Runtime كامل
 *  GET  /accounts/:id/runtime/attempts     — سجل محاولات الاتصال
 *  GET  /accounts/:id/runtime/attempts/:attemptId/timeline — Timeline محاولة محددة
 *  GET  /accounts/:id/runtime/errors       — أنماط الأخطاء
 *  GET  /accounts/:id/runtime/stats        — إحصائيات الاتصال
 *  GET  /admin/runtime/stats               — إحصائيات النظام (Admin)
 */

const RuntimeAnalyzer = require('../services/RuntimeAnalyzer');
const { queryOne }    = require('../../lib/postgres');

class RuntimeController {

    // ── GET /accounts/:id/runtime/report ─────────────────────────────────────
    async getFullReport(req, res) {
        try {
            const { id: accountId } = req.params;

            // تحقق من ملكية الحساب
            const account = await queryOne(
                `SELECT id, name, status FROM accounts WHERE id = $1 AND user_id = $2`,
                [accountId, req.user.id]
            );
            if (!account && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
                return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            }

            const report = await RuntimeAnalyzer.getFullRuntimeReport(accountId);

            return res.json({
                success: true,
                account: account || { id: accountId },
                report,
            });
        } catch (err) {
            console.error('[RuntimeController] getFullReport error:', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
        }
    }

    // ── GET /accounts/:id/runtime/attempts ───────────────────────────────────
    async getRecentAttempts(req, res) {
        try {
            const { id: accountId } = req.params;
            const limit = Math.min(parseInt(req.query.limit || '10'), 50);

            const attempts = await RuntimeAnalyzer.getRecentAttempts(accountId, limit);

            return res.json({
                success: true,
                accountId,
                total: attempts.length,
                attempts,
            });
        } catch (err) {
            console.error('[RuntimeController] getRecentAttempts error:', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
        }
    }

    // ── GET /accounts/:id/runtime/attempts/:attemptId/timeline ───────────────
    async getAttemptTimeline(req, res) {
        try {
            const { id: accountId, attemptId } = req.params;

            const timeline = await RuntimeAnalyzer.getAttemptTimeline(attemptId);

            if (!timeline) {
                return res.status(404).json({ success: false, error: 'المحاولة غير موجودة' });
            }

            // تأكد من أن المحاولة تخص الحساب المطلوب
            if (timeline.attempt.account_id !== accountId) {
                return res.status(403).json({ success: false, error: 'غير مصرح' });
            }

            return res.json({
                success: true,
                timeline,
            });
        } catch (err) {
            console.error('[RuntimeController] getAttemptTimeline error:', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
        }
    }

    // ── GET /accounts/:id/runtime/errors ─────────────────────────────────────
    async getErrorPatterns(req, res) {
        try {
            const { id: accountId } = req.params;
            const hours = Math.min(parseInt(req.query.hours || '24'), 168); // max 7 days

            const patterns = await RuntimeAnalyzer.getErrorPatterns(accountId, hours);

            return res.json({
                success: true,
                accountId,
                ...patterns,
            });
        } catch (err) {
            console.error('[RuntimeController] getErrorPatterns error:', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
        }
    }

    // ── GET /accounts/:id/runtime/stats ──────────────────────────────────────
    async getConnectionStats(req, res) {
        try {
            const { id: accountId } = req.params;
            const days = Math.min(parseInt(req.query.days || '7'), 30);

            const stats = await RuntimeAnalyzer.getConnectionStats(accountId, days);

            return res.json({
                success: true,
                accountId,
                ...stats,
            });
        } catch (err) {
            console.error('[RuntimeController] getConnectionStats error:', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
        }
    }

    // ── GET /admin/runtime/stats ──────────────────────────────────────────────
    async getSystemStats(req, res) {
        try {
            const hours = Math.min(parseInt(req.query.hours || '24'), 168);

            const stats = await RuntimeAnalyzer.getSystemRuntimeStats(hours);

            return res.json({
                success: true,
                ...stats,
            });
        } catch (err) {
            console.error('[RuntimeController] getSystemStats error:', err.message);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم' });
        }
    }
}

module.exports = new RuntimeController();
