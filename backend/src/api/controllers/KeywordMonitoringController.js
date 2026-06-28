'use strict';
const KeywordMonitoringService = require('../services/KeywordMonitoringService');

const KWController = {

    // ── الكلمات المفتاحية ─────────────────────────────────────────────────

    async listKeywords(req, res) {
        try {
            const keywords = await KeywordMonitoringService.getKeywords(req.user.id);
            res.json({ success: true, keywords });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async addKeyword(req, res) {
        try {
            const kw = await KeywordMonitoringService.addKeyword(req.user.id, req.body);
            res.json({ success: true, keyword: kw });
        } catch (err) {
            const status = err.message.includes('موجودة') ? 409 : 500;
            res.status(status).json({ success: false, error: err.message });
        }
    },

    async updateKeyword(req, res) {
        try {
            const kw = await KeywordMonitoringService.updateKeyword(req.user.id, req.params.id, req.body);
            res.json({ success: true, keyword: kw });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async deleteKeyword(req, res) {
        try {
            await KeywordMonitoringService.deleteKeyword(req.user.id, req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async exportKeywords(req, res) {
        try {
            const keywords = await KeywordMonitoringService.exportKeywords(req.user.id);
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Content-Disposition', 'attachment; filename="keywords.json"');
            res.send(JSON.stringify(keywords, null, 2));
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async importKeywords(req, res) {
        try {
            const { keywords } = req.body;
            if (!Array.isArray(keywords)) return res.status(400).json({ success: false, error: 'البيانات غير صحيحة' });
            const result = await KeywordMonitoringService.importKeywords(req.user.id, keywords);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── التنبيهات ─────────────────────────────────────────────────────────

    async listAlerts(req, res) {
        try {
            const { page, limit, keyword, group_name, status, phone, date_from, date_to } = req.query;
            const result = await KeywordMonitoringService.getAlerts(req.user.id, {
                page:       parseInt(page)  || 1,
                limit:      parseInt(limit) || 20,
                keyword, group_name, status, phone, date_from, date_to,
            });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async updateAlertStatus(req, res) {
        try {
            const { status, note } = req.body;
            const alert = await KeywordMonitoringService.updateAlertStatus(req.user.id, req.params.id, status, note);
            res.json({ success: true, alert });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async deleteAlert(req, res) {
        try {
            await KeywordMonitoringService.deleteAlert(req.user.id, req.params.id);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async addAlertNote(req, res) {
        try {
            const { note } = req.body;
            const alert = await KeywordMonitoringService.addAlertNote(req.user.id, req.params.id, note);
            res.json({ success: true, alert });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── الإحصائيات ────────────────────────────────────────────────────────

    async getStats(req, res) {
        try {
            const stats = await KeywordMonitoringService.getStats(req.user.id);
            res.json({ success: true, stats });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── الإعدادات ─────────────────────────────────────────────────────────

    async getSettings(req, res) {
        try {
            const settings = await KeywordMonitoringService.getSettings(req.user.id);
            res.json({ success: true, settings });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    async saveSettings(req, res) {
        try {
            const settings = await KeywordMonitoringService.saveSettings(req.user.id, req.body);
            res.json({ success: true, settings });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── سجل النشاط ───────────────────────────────────────────────────────

    async getActivityLog(req, res) {
        try {
            const logs = await KeywordMonitoringService.getActivityLog(req.user.id, parseInt(req.query.limit) || 50);
            res.json({ success: true, logs });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    },
};

module.exports = KWController;

