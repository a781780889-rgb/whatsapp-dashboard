'use strict';
/**
 * SessionAnalyzerController.js — واجهة API لتحليل الجلسات المتعمق
 * المرحلة السادسة من نظام التشخيص
 */

const SessionAnalyzer = require('../services/SessionAnalyzer');

class SessionAnalyzerController {

    /**
     * GET /api/v1/accounts/:id/session/report
     * تقرير شامل لجلسة حساب محدد (creds + signal keys + تقييم)
     */
    async getAccountReport(req, res) {
        try {
            const { id } = req.params;
            const report  = await SessionAnalyzer.generateAccountReport(id);
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[SessionAnalyzer] getAccountReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/session/credentials
     * تحليل creds فقط لحساب محدد (بدون كشف مفاتيح حساسة)
     */
    async getCredentials(req, res) {
        try {
            const { id } = req.params;
            const result  = await SessionAnalyzer.analyzeCredentials(id);
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[SessionAnalyzer] getCredentials:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/session/signal-keys
     * فحص سلامة Signal Keys لحساب محدد
     */
    async getSignalKeys(req, res) {
        try {
            const { id } = req.params;
            const result  = await SessionAnalyzer.analyzeSignalKeys(id);
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[SessionAnalyzer] getSignalKeys:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/session/stats
     * إحصائيات session_data لحساب محدد (الأحجام، الأعداد، آخر تحديث)
     */
    async getAccountStats(req, res) {
        try {
            const { id } = req.params;
            const result  = await SessionAnalyzer.getSessionStats(id);
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[SessionAnalyzer] getAccountStats:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/session/report
     * تقرير شامل لجميع الجلسات في النظام
     */
    async getSystemReport(req, res) {
        try {
            const report = await SessionAnalyzer.generateSystemReport();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[SessionAnalyzer] getSystemReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/session/stats
     * إحصائيات إجمالية لجلسات كل النظام
     */
    async getSystemStats(req, res) {
        try {
            const stats = await SessionAnalyzer.getSystemStats();
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[SessionAnalyzer] getSystemStats:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/session/stale
     * قائمة الجلسات القديمة (أكثر من 30 يوم بدون تحديث)
     */
    async getStaleAccounts(req, res) {
        try {
            const result = await SessionAnalyzer.getStaleAccounts();
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[SessionAnalyzer] getStaleAccounts:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new SessionAnalyzerController();
