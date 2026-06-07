'use strict';
const DatabaseManager = require('../../database/DatabaseManager');

class LinkSettingsController {

    async getSearchSettings(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            let settings = await accountDB.get(`SELECT * FROM link_search_settings WHERE id = 'default'`);
            if (!settings) {
                await accountDB.run(`INSERT INTO link_search_settings (id) VALUES ('default') ON CONFLICT DO NOTHING`);
                settings = await accountDB.get(`SELECT * FROM link_search_settings WHERE id = 'default'`);
            }
            res.json({
                success: true,
                settings: {
                    ...settings,
                    allowed_account_ids: JSON.parse(settings?.allowed_account_ids || '[]'),
                    allowed_group_jids:  JSON.parse(settings?.allowed_group_jids  || '[]'),
                }
            });
        } catch (err) {
            console.error('GetSearchSettings error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async updateSearchSettings(req, res) {
        try {
            const { accountId } = req.params;
            const { allowed_account_ids, allowed_group_jids, deep_search_enabled,
                    search_by_date_from, search_by_date_to, filter_country,
                    filter_domain, filter_region } = req.body;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            await accountDB.run(
                `INSERT INTO link_search_settings
                 (id, allowed_account_ids, allowed_group_jids, deep_search_enabled,
                  search_by_date_from, search_by_date_to, filter_country, filter_domain,
                  filter_region, updated_at)
                 VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   allowed_account_ids  = EXCLUDED.allowed_account_ids,
                   allowed_group_jids   = EXCLUDED.allowed_group_jids,
                   deep_search_enabled  = EXCLUDED.deep_search_enabled,
                   search_by_date_from  = EXCLUDED.search_by_date_from,
                   search_by_date_to    = EXCLUDED.search_by_date_to,
                   filter_country       = EXCLUDED.filter_country,
                   filter_domain        = EXCLUDED.filter_domain,
                   filter_region        = EXCLUDED.filter_region,
                   updated_at           = NOW()`,
                [
                    JSON.stringify(allowed_account_ids || []),
                    JSON.stringify(allowed_group_jids  || []),
                    deep_search_enabled ? true : false,
                    search_by_date_from || null,
                    search_by_date_to   || null,
                    filter_country      || null,
                    filter_domain       || null,
                    filter_region       || null,
                ]
            );

            res.json({ success: true, message: 'تم حفظ إعدادات البحث' });
        } catch (err) {
            console.error('UpdateSearchSettings error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getJoinSettings(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            let settings = await accountDB.get(`SELECT * FROM auto_join_settings WHERE id = 'default'`);
            if (!settings) {
                await accountDB.run(`INSERT INTO auto_join_settings (id) VALUES ('default') ON CONFLICT DO NOTHING`);
                settings = await accountDB.get(`SELECT * FROM auto_join_settings WHERE id = 'default'`);
            }
            res.json({
                success: true,
                settings: {
                    ...settings,
                    allowed_account_ids: JSON.parse(settings?.allowed_account_ids || '[]'),
                }
            });
        } catch (err) {
            console.error('GetJoinSettings error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async updateJoinSettings(req, res) {
        try {
            const { accountId } = req.params;
            const { allowed_account_ids, max_joins_per_day, delay_between_joins_minutes,
                    exclude_banned, enabled } = req.body;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            await accountDB.run(
                `INSERT INTO auto_join_settings
                 (id, allowed_account_ids, max_joins_per_day, delay_between_joins_minutes,
                  exclude_banned, enabled, updated_at)
                 VALUES ('default', $1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                   allowed_account_ids           = EXCLUDED.allowed_account_ids,
                   max_joins_per_day             = EXCLUDED.max_joins_per_day,
                   delay_between_joins_minutes   = EXCLUDED.delay_between_joins_minutes,
                   exclude_banned                = EXCLUDED.exclude_banned,
                   enabled                       = EXCLUDED.enabled,
                   updated_at                    = NOW()`,
                [
                    JSON.stringify(allowed_account_ids || []),
                    max_joins_per_day             || 10,
                    delay_between_joins_minutes   || 5,
                    exclude_banned !== undefined ? exclude_banned : true,
                    enabled        !== undefined ? enabled        : true,
                ]
            );

            res.json({ success: true, message: 'تم حفظ إعدادات الانضمام' });
        } catch (err) {
            console.error('UpdateJoinSettings error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async importLinks(req, res) {
        try {
            const { accountId } = req.params;
            if (!req.body.links || !Array.isArray(req.body.links))
                return res.status(400).json({ success: false, error: 'يجب إرسال مصفوفة روابط' });

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const LinkExtractorService = require('../services/LinkExtractorService');

            let importedCount = 0;
            for (const url of req.body.links) {
                if (typeof url === 'string' && url.startsWith('http')) {
                    await LinkExtractorService.extractAndSave(accountId, accountDB, url, '', 'imported', 'imported_user');
                    importedCount++;
                }
            }

            res.json({ success: true, message: `تم استيراد ${importedCount} رابط بنجاح` });
        } catch (err) {
            console.error('ImportLinks error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new LinkSettingsController();
