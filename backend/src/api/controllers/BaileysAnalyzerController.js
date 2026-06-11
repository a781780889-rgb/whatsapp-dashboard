'use strict';
/**
 * BaileysAnalyzerController.js — المرحلة التاسعة
 * API Controller لتحليل Baileys المتعمق
 */

const BaileysAnalyzer = require('../services/BaileysAnalyzer');

class BaileysAnalyzerController {

    // ── Per-Account ───────────────────────────────────────────────────────────

    /**
     * GET /api/v1/accounts/:id/baileys/report
     * تقرير شامل: إحصائيات + أحداث + رسائل + مشاكل
     */
    async getAccountReport(req, res) {
        try {
            const report = await BaileysAnalyzer.generateAccountReport(req.params.id);
            res.json({ success: true, data: report });
        } catch (err) {
            console.error('[BaileysController] getAccountReport:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/baileys/stats
     * إحصائيات مختصرة لحساب
     */
    async getAccountStats(req, res) {
        try {
            const stats = await BaileysAnalyzer.getAccountStats(req.params.id);
            res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[BaileysController] getAccountStats:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/baileys/history?limit=50
     * تاريخ الأحداث الأخيرة
     */
    async getAccountHistory(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 50, 100);
            const history = await BaileysAnalyzer.getAccountHistory(req.params.id, limit);
            res.json({ success: true, data: history, count: history.length });
        } catch (err) {
            console.error('[BaileysController] getAccountHistory:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/baileys/events
     * توزيع الأحداث حسب الفئة
     */
    async getEventBreakdown(req, res) {
        try {
            const breakdown = await BaileysAnalyzer.getEventBreakdown(req.params.id);
            res.json({ success: true, data: breakdown });
        } catch (err) {
            console.error('[BaileysController] getEventBreakdown:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/baileys/messages/errors?limit=30
     * أخطاء الرسائل لحساب
     */
    async getMessageErrors(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 30, 100);
            const errors = await BaileysAnalyzer.getMessageErrors(req.params.id, limit);
            res.json({ success: true, data: errors, count: errors.length });
        } catch (err) {
            console.error('[BaileysController] getMessageErrors:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    // ── Admin ─────────────────────────────────────────────────────────────────

    /**
     * GET /api/v1/admin/baileys/report
     * تقرير النظام الشامل
     */
    async getSystemReport(req, res) {
        try {
            const report = await BaileysAnalyzer.generateSystemReport();
            res.json({ success: true, data: report });
        } catch (err) {
            console.error('[BaileysController] getSystemReport:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/baileys/stats
     * إحصائيات إجمالية للنظام
     */
    async getSystemStats(req, res) {
        try {
            const stats = await BaileysAnalyzer.getSystemStats();
            res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[BaileysController] getSystemStats:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/baileys/problematic?limit=20
     * الحسابات ذات معدل خطأ أو بطء مرتفع
     */
    async getProblematicAccounts(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 20, 50);
            const accounts = await BaileysAnalyzer.getProblematicAccounts(limit);
            res.json({ success: true, data: accounts, count: accounts.length });
        } catch (err) {
            console.error('[BaileysController] getProblematicAccounts:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new BaileysAnalyzerController();
