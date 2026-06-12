'use strict';
/**
 * InfrastructureController — المرحلة العاشرة
 *
 * Routes:
 * GET /api/v1/admin/infra/report          ← تقرير شامل
 * GET /api/v1/admin/infra/stats           ← إحصائيات سريعة
 * GET /api/v1/admin/infra/postgres        ← صحة PostgreSQL التفصيلية
 * GET /api/v1/admin/infra/postgres/tables ← إحصائيات الجداول
 * GET /api/v1/admin/infra/redis           ← صحة Redis التفصيلية
 * GET /api/v1/admin/infra/redis/keys      ← توزيع Redis Keys
 * GET /api/v1/admin/infra/bullmq          ← BullMQ Queue Stats
 * GET /api/v1/admin/infra/process         ← Process & System Info
 */

const InfrastructureAnalyzer = require('../services/InfrastructureAnalyzer');

class InfrastructureController {

    /** GET /admin/infra/report — تقرير شامل للبنية التحتية */
    async getSystemReport(req, res) {
        try {
            const report = await InfrastructureAnalyzer.generateSystemReport();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[InfraController] getSystemReport error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/stats — إحصائيات سريعة */
    async getQuickStats(req, res) {
        try {
            const stats = await InfrastructureAnalyzer.getQuickStats();
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[InfraController] getQuickStats error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/postgres — صحة PostgreSQL التفصيلية */
    async getPostgresHealth(req, res) {
        try {
            const health = await InfrastructureAnalyzer.getPostgresHealth();
            return res.json({ success: true, data: health });
        } catch (err) {
            console.error('[InfraController] getPostgresHealth error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/postgres/tables — إحصائيات الجداول */
    async getPostgresTableStats(req, res) {
        try {
            const tables = await InfrastructureAnalyzer.getPostgresTableStats();
            return res.json({ success: true, data: { tables, count: tables.length } });
        } catch (err) {
            console.error('[InfraController] getPostgresTableStats error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/redis — صحة Redis التفصيلية */
    async getRedisHealth(req, res) {
        try {
            const health = await InfrastructureAnalyzer.getRedisHealth();
            return res.json({ success: true, data: health });
        } catch (err) {
            console.error('[InfraController] getRedisHealth error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/redis/keys — توزيع Redis Keys */
    async getRedisKeyDistribution(req, res) {
        try {
            const distribution = await InfrastructureAnalyzer.getRedisKeyDistribution();
            return res.json({ success: true, data: { distribution, count: distribution.length } });
        } catch (err) {
            console.error('[InfraController] getRedisKeyDistribution error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/bullmq — BullMQ Queue Stats */
    async getBullMQStats(req, res) {
        try {
            const stats = await InfrastructureAnalyzer.getBullMQStats();
            return res.json({ success: true, data: stats });
        } catch (err) {
            console.error('[InfraController] getBullMQStats error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /** GET /admin/infra/process — Process & System Info */
    async getProcessInfo(req, res) {
        try {
            const [processStats, cpu] = await Promise.all([
                Promise.resolve(InfrastructureAnalyzer.getProcessStats()),
                InfrastructureAnalyzer.getCPUUsage(),
            ]);
            return res.json({ success: true, data: { ...processStats, cpu } });
        } catch (err) {
            console.error('[InfraController] getProcessInfo error:', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new InfrastructureController();
