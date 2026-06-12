'use strict';
/**
 * DatabaseAnalyzerController.js — واجهة API لنظام تحليل قاعدة البيانات
 * المرحلة الرابعة من نظام التشخيص
 */

const DatabaseAnalyzer = require('../services/DatabaseAnalyzer');

class DatabaseAnalyzerController {

    /**
     * GET /api/v1/admin/db/report
     * تقرير شامل لحالة قاعدة البيانات كاملة
     */
    async getFullReport(req, res) {
        try {
            const report = await DatabaseAnalyzer.generateFullReport();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[DBAnalyzer] getFullReport error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/db/contradictions
     * فحص الحالات المتناقضة في accounts + subscriptions
     */
    async getContradictions(req, res) {
        try {
            const [accounts, subscriptions] = await Promise.all([
                DatabaseAnalyzer.detectAccountContradictions(),
                DatabaseAnalyzer.detectSubscriptionContradictions(),
            ]);

            const totalIssues = accounts.contradictionCount + subscriptions.contradictionCount;

            return res.json({
                success: true,
                data: {
                    totalIssues,
                    accounts,
                    subscriptions,
                    analyzedAt: new Date().toISOString(),
                },
            });
        } catch (err) {
            console.error('[DBAnalyzer] getContradictions error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/db/bloat
     * تحليل حجم session_data لكل حساب
     */
    async getBloatReport(req, res) {
        try {
            const report = await DatabaseAnalyzer.analyzeSessionBloat();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[DBAnalyzer] getBloatReport error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/db/performance
     * تحليل أداء الفهارس والاستعلامات
     */
    async getPerformanceReport(req, res) {
        try {
            const report = await DatabaseAnalyzer.analyzePerformance();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[DBAnalyzer] getPerformanceReport error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/db/health
     * فحص سلامة session_data لحساب محدد
     */
    async getAccountDbHealth(req, res) {
        try {
            const { id } = req.params;
            const report  = await DatabaseAnalyzer.analyzeAccountSession(id);
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[DBAnalyzer] getAccountDbHealth error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/db/check
     * فحص سريع شامل للحساب (account + session + تناقضات)
     */
    async quickAccountCheck(req, res) {
        try {
            const { id } = req.params;
            const result  = await DatabaseAnalyzer.quickAccountCheck(id);
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[DBAnalyzer] quickAccountCheck error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/db/stats
     * إحصائيات سريعة (عدد الجداول، الأحجام، ...)
     */
    async getStats(req, res) {
        try {
            const stats = await DatabaseAnalyzer._gatherStats();
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[DBAnalyzer] getStats error:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new DatabaseAnalyzerController();

