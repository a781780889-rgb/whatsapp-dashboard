'use strict';
/**
 * ConnectionCycleController.js — المرحلة الثالثة
 * API Controller لتحليل دورة الاتصال الكاملة
 */

const ConnectionCycleAnalyzer = require('../services/ConnectionCycleAnalyzer');
const { queryOne } = require('../../lib/postgres');

class ConnectionCycleController {

    /**
     * GET /accounts/:id/cycle/latest
     * تحليل آخر محاولة اتصال كاملة
     */
    async getLatestCycle(req, res) {
        try {
            const accountId = req.params.id;
            const { queryAll } = require('../../lib/postgres');

            // جلب آخر محاولة للحساب
            const attempt = await queryOne(`
                SELECT id FROM connection_attempts
                WHERE account_id = $1
                ORDER BY started_at DESC
                LIMIT 1
            `, [accountId]);

            if (!attempt) {
                return res.json({
                    success: true,
                    data:    null,
                    message: 'لا توجد محاولات اتصال مسجلة بعد',
                });
            }

            const analysis = await ConnectionCycleAnalyzer.getCycleAnalysis(accountId, attempt.id);

            return res.json({ success: true, data: analysis });
        } catch (err) {
            console.error('[CycleController] getLatestCycle:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /accounts/:id/cycle/attempts/:attemptId
     * تحليل محاولة محددة
     */
    async getCycleByAttempt(req, res) {
        try {
            const { id: accountId, attemptId } = req.params;
            const analysis = await ConnectionCycleAnalyzer.getCycleAnalysis(accountId, attemptId);

            if (!analysis) {
                return res.status(404).json({
                    success: false,
                    error:   'لم يتم العثور على دورة اتصال لهذه المحاولة',
                });
            }

            return res.json({ success: true, data: analysis });
        } catch (err) {
            console.error('[CycleController] getCycleByAttempt:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /accounts/:id/cycle/attempts/:attemptId/report
     * تقرير نصي مفصل لدورة اتصال
     */
    async getCycleReport(req, res) {
        try {
            const { id: accountId, attemptId } = req.params;
            const report = await ConnectionCycleAnalyzer.getCycleSummaryReport(accountId, attemptId);

            if (!report) {
                return res.status(404).json({
                    success: false,
                    error:   'لا توجد بيانات كافية لإنشاء التقرير',
                });
            }

            return res.json({ success: true, data: { report, attemptId, accountId } });
        } catch (err) {
            console.error('[CycleController] getCycleReport:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /accounts/:id/cycle/history?limit=10
     * آخر N دورة اتصال لحساب
     */
    async getRecentCycles(req, res) {
        try {
            const accountId = req.params.id;
            const limit     = Math.min(50, parseInt(req.query.limit || '10', 10));
            const cycles    = await ConnectionCycleAnalyzer.getRecentCycles(accountId, limit);

            return res.json({ success: true, data: cycles, count: cycles.length });
        } catch (err) {
            console.error('[CycleController] getRecentCycles:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /accounts/:id/cycle/stats?days=7
     * إحصائيات شاملة لدورات الاتصال
     */
    async getCycleStats(req, res) {
        try {
            const accountId = req.params.id;
            const days      = Math.min(30, parseInt(req.query.days || '7', 10));
            const stats     = await ConnectionCycleAnalyzer.getCycleStats(accountId, days);

            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[CycleController] getCycleStats:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /admin/cycle/stats?hours=24
     * إحصائيات Admin — نظرة عامة على كل النظام
     */
    async getSystemStats(req, res) {
        try {
            const hours = Math.min(168, parseInt(req.query.hours || '24', 10));
            const stats = await ConnectionCycleAnalyzer.getSystemCycleStats(hours);

            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[CycleController] getSystemStats:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /accounts/:id/cycle/anomalies?limit=20
     * قائمة الشذوذات المكتشفة لحساب معين
     */
    async getAnomalies(req, res) {
        try {
            const accountId = req.params.id;
            const limit     = Math.min(100, parseInt(req.query.limit || '20', 10));
            const { queryAll } = require('../../lib/postgres');

            const anomalies = await queryAll(`
                SELECT cya.*, ca.connection_type, ca.outcome
                FROM cycle_anomalies cya
                LEFT JOIN connection_attempts ca ON ca.id = cya.attempt_id
                WHERE cya.account_id = $1
                ORDER BY cya.created_at DESC
                LIMIT $2
            `, [accountId, limit]);

            return res.json({
                success: true,
                data:    anomalies,
                count:   anomalies.length,
            });
        } catch (err) {
            console.error('[CycleController] getAnomalies:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new ConnectionCycleController();

