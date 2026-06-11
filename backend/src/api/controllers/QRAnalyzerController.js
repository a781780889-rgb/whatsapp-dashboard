'use strict';
/**
 * QRAnalyzerController.js — واجهة API لتحليل QR Code
 * المرحلة السابعة من نظام التشخيص
 */

const QRAnalyzer = require('../services/QRAnalyzer');

class QRAnalyzerController {

    /**
     * GET /api/v1/accounts/:id/qr/report
     * تقرير شامل لـ QR لحساب محدد (إحصائيات + تاريخ + تأخير + مشاكل)
     */
    async getAccountReport(req, res) {
        try {
            const { id } = req.params;
            const report  = await QRAnalyzer.generateAccountReport(id);
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[QRAnalyzer] getAccountReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/qr/stats
     * إحصائيات QR مختصرة لحساب محدد
     */
    async getAccountStats(req, res) {
        try {
            const { id } = req.params;
            const stats   = await QRAnalyzer.getAccountStats(id);
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[QRAnalyzer] getAccountStats:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/qr/history
     * تاريخ رموز QR لحساب محدد
     * Query params: limit (default 50)
     */
    async getAccountHistory(req, res) {
        try {
            const { id }  = req.params;
            const limit   = Math.min(parseInt(req.query.limit) || 50, 200);
            const history = await QRAnalyzer.getAccountHistory(id, limit);
            return res.json({ success: true, data: history, count: history.length });
        } catch (err) {
            console.error('[QRAnalyzer] getAccountHistory:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/qr/latency
     * تحليل التأخير (Generation + Scan latency) لحساب محدد
     */
    async getLatency(req, res) {
        try {
            const { id } = req.params;
            const data    = await QRAnalyzer.getLatencyBreakdown(id);
            return res.json({ success: true, data });
        } catch (err) {
            console.error('[QRAnalyzer] getLatency:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/qr/report
     * تقرير QR شامل لكل النظام
     */
    async getSystemReport(req, res) {
        try {
            const report = await QRAnalyzer.generateSystemReport();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[QRAnalyzer] getSystemReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/qr/stats
     * إحصائيات QR إجمالية للنظام
     */
    async getSystemStats(req, res) {
        try {
            const stats = await QRAnalyzer.getSystemStats();
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[QRAnalyzer] getSystemStats:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/qr/slow
     * الحسابات ذات QR بطيء التوليد أو منخفض نسبة النجاح
     * Query params: limit (default 20)
     */
    async getSlowAccounts(req, res) {
        try {
            const limit = Math.min(parseInt(req.query.limit) || 20, 100);
            const data   = await QRAnalyzer.getSlowAccounts(limit);
            return res.json({ success: true, data, count: data.length });
        } catch (err) {
            console.error('[QRAnalyzer] getSlowAccounts:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new QRAnalyzerController();
