'use strict';
/**
 * PairingCodeAnalyzerController.js — واجهة API لتحليل Pairing Code
 * المرحلة الثامنة من نظام التشخيص
 */

const PairingCodeAnalyzer = require('../services/PairingCodeAnalyzer');

class PairingCodeAnalyzerController {

    /**
     * GET /api/v1/accounts/:id/pairing/report
     * تقرير شامل لـ Pairing Code لحساب محدد
     * (إحصائيات + تاريخ + تأخير + مشاكل)
     */
    async getAccountReport(req, res) {
        try {
            const { id } = req.params;
            const report  = await PairingCodeAnalyzer.generateAccountReport(id);
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getAccountReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/pairing/stats
     * إحصائيات Pairing Code مختصرة لحساب محدد
     */
    async getAccountStats(req, res) {
        try {
            const { id } = req.params;
            const stats   = await PairingCodeAnalyzer.getAccountStats(id);
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getAccountStats:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/pairing/history
     * تاريخ محاولات Pairing Code لحساب محدد
     * Query params: limit (default 50, max 200)
     */
    async getAccountHistory(req, res) {
        try {
            const { id }  = req.params;
            const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
            const history = await PairingCodeAnalyzer.getAccountHistory(id, limit);
            return res.json({ success: true, data: history, count: history.length });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getAccountHistory:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/pairing/latency
     * تحليل التأخير الثلاثي (Request + Display + Entry) لحساب محدد
     */
    async getLatency(req, res) {
        try {
            const { id } = req.params;
            const data    = await PairingCodeAnalyzer.getLatencyBreakdown(id);
            return res.json({ success: true, data });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getLatency:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/pairing/report
     * تقرير Pairing Code شامل لكل النظام
     */
    async getSystemReport(req, res) {
        try {
            const report = await PairingCodeAnalyzer.generateSystemReport();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getSystemReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/pairing/stats
     * إحصائيات Pairing Code إجمالية للنظام
     */
    async getSystemStats(req, res) {
        try {
            const stats = await PairingCodeAnalyzer.getSystemStats();
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getSystemStats:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/pairing/problematic
     * الحسابات ذات معدل فشل أو بطء مرتفع في Pairing Code
     * Query params: limit (default 20, max 100)
     */
    async getProblematicAccounts(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 20, 100);
            const data   = await PairingCodeAnalyzer.getProblematicAccounts(limit);
            return res.json({ success: true, data, count: data.length });
        } catch (err) {
            console.error('[PairingCodeAnalyzer] getProblematicAccounts:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new PairingCodeAnalyzerController();
