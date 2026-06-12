'use strict';
/**
 * RedisAnalyzerController.js — واجهة API لنظام تحليل Redis
 * المرحلة الخامسة من نظام التشخيص
 */

const RedisAnalyzer = require('../services/RedisAnalyzer');

class RedisAnalyzerController {

    /**
     * GET /api/v1/admin/redis/report
     * تقرير شامل لحالة Redis كاملة
     */
    async getFullReport(req, res) {
        try {
            const report = await RedisAnalyzer.generateFullReport();
            return res.json({ success: true, data: report });
        } catch (err) {
            console.error('[RedisAnalyzer] getFullReport:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/redis/connection
     * فحص الاتصال والمعلومات الأساسية لـ Redis
     */
    async getConnectionInfo(req, res) {
        try {
            const info = await RedisAnalyzer.checkConnection();
            return res.json({ success: true, data: info });
        } catch (err) {
            console.error('[RedisAnalyzer] getConnectionInfo:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/redis/rate-keys
     * تحليل مفاتيح Rate Limiting لجميع الحسابات
     */
    async getAllRateKeys(req, res) {
        try {
            const result = await RedisAnalyzer.analyzeAllRateKeys();
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[RedisAnalyzer] getAllRateKeys:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/accounts/:id/redis/rate-keys
     * تحليل مفاتيح Rate Limiting لحساب محدد
     */
    async getAccountRateKeys(req, res) {
        try {
            const { id } = req.params;
            const result  = await RedisAnalyzer.analyzeAccountRateKeys(id);
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[RedisAnalyzer] getAccountRateKeys:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/redis/jwt-blacklist
     * تحليل JWT Blacklist
     */
    async getJWTBlacklist(req, res) {
        try {
            const result = await RedisAnalyzer.analyzeJWTBlacklist();
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[RedisAnalyzer] getJWTBlacklist:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/redis/bullmq
     * تحليل حالة BullMQ Queues
     */
    async getBullMQStatus(req, res) {
        try {
            const result = await RedisAnalyzer.analyzeBullMQJobs();
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[RedisAnalyzer] getBullMQStatus:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/redis/no-ttl
     * كشف المفاتيح بدون TTL
     */
    async getNoTTLKeys(req, res) {
        try {
            const result = await RedisAnalyzer.detectNoTTLKeys();
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[RedisAnalyzer] getNoTTLKeys:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    /**
     * GET /api/v1/admin/redis/memory
     * توزيع الذاكرة حسب نمط المفتاح
     */
    async getMemoryDistribution(req, res) {
        try {
            const result = await RedisAnalyzer.analyzeMemoryDistribution();
            return res.json({ success: true, data: result });
        } catch (err) {
            console.error('[RedisAnalyzer] getMemoryDistribution:', err);
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new RedisAnalyzerController();
