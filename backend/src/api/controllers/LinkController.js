'use strict';
/**
 * LinkController — الجزء الثالث
 * تحكم متقدم في الروابط: استعلام / انضمام / مراقبة / طابور
 */
const DatabaseManager    = require('../../database/DatabaseManager');
const GroupJoinerService = require('../services/GroupJoinerService');
const LinkMonitorEngine  = require('../services/LinkMonitorEngine');
const crypto             = require('crypto');

class LinkController {

    // ══════════════════════════════════════════════════════════════════════════
    //  إنشاء الجداول إن لم تكن موجودة
    // ══════════════════════════════════════════════════════════════════════════
    async _ensureLinksTable(accountDB) {
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS link_categories (
                id          SERIAL PRIMARY KEY,
                name        TEXT NOT NULL,
                color       TEXT DEFAULT '#6366f1',
                created_at  TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS extracted_links (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                url          TEXT NOT NULL,
                domain       TEXT,
                link_type    TEXT DEFAULT 'other',
                category_id  INTEGER REFERENCES link_categories(id) ON DELETE SET NULL,
                ai_rating    NUMERIC(3,1) DEFAULT 0,
                is_spam      BOOLEAN DEFAULT FALSE,
                status       TEXT DEFAULT 'active',
                country      TEXT,
                extracted_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at   TIMESTAMPTZ DEFAULT NOW()
            )
        `);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  جلب الروابط
    // ══════════════════════════════════════════════════════════════════════════
    async getLinks(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureLinksTable(accountDB);

            const limit     = Math.min(parseInt(req.query.limit) || 100, 500);
            const status    = req.query.status    || 'active';
            const search    = req.query.search    || null;
            const categoryId= req.query.categoryId || null;
            const minRating = parseInt(req.query.minRating) || 0;
            const hideSpam  = req.query.hideSpam  === 'true';
            const spamOnly  = req.query.spamOnly  === 'true';
            const dateFrom  = req.query.dateFrom  || null;
            const dateTo    = req.query.dateTo    || null;
            const linkType  = req.query.linkType  || null;
            const country   = req.query.country   || null;
            const sortBy    = ['extracted_at','ai_rating','domain','link_type'].includes(req.query.sortBy)
                              ? req.query.sortBy : 'extracted_at';
            const sortDir   = req.query.sortDir === 'ASC' ? 'ASC' : 'DESC';

            const conditions = ['l.status = $1'];
            const params     = [status];
            let   pIdx       = 2;

            const add = (cond, val) => {
                conditions.push(cond.replace('?', `$${pIdx++}`));
                params.push(val);
            };

            if (search) {
                search.trim().split(/\s+/).forEach(term => {
                    conditions.push(`(l.url ILIKE $${pIdx} OR l.domain ILIKE $${pIdx + 1})`);
                    params.push(`%${term}%`, `%${term}%`);
                    pIdx += 2;
                });
            }
            if (categoryId) add(`l.category_id = ?`, categoryId);
            if (minRating > 0) add(`l.ai_rating >= ?`, minRating);
            if (hideSpam)      add(`l.is_spam = ?`, false);
            if (spamOnly)      add(`l.is_spam = ?`, true);
            if (dateFrom)      add(`l.extracted_at >= ?`, dateFrom);
            if (dateTo)        add(`l.extracted_at <= ?`, dateTo + ' 23:59:59');
            if (linkType)      add(`l.link_type = ?`, linkType);
            if (country)       add(`l.country = ?`, country);

            const where = conditions.join(' AND ');
            const query = `
                SELECT l.*, c.name AS category_name, c.color AS category_color
                FROM   extracted_links l
                LEFT JOIN link_categories c ON l.category_id = c.id
                WHERE  ${where}
                ORDER BY l.${sortBy} ${sortDir}
                LIMIT  $${pIdx}
            `;
            params.push(limit);

            const links = await accountDB.all(query, params);
            res.json({ success: true, links, count: links.length });

        } catch (error) {
            console.error('GetLinks Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  إحصائيات الروابط
    // ══════════════════════════════════════════════════════════════════════════
    async getStats(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureLinksTable(accountDB);

            const [total, spam, safe, avgRow, byType, topDomains, recent] = await Promise.all([
                accountDB.get(`SELECT COUNT(*) AS cnt FROM extracted_links WHERE status='active'`),
                accountDB.get(`SELECT COUNT(*) AS cnt FROM extracted_links WHERE is_spam=TRUE`),
                accountDB.get(`SELECT COUNT(*) AS cnt FROM extracted_links WHERE is_spam=FALSE AND status='active'`),
                accountDB.get(`SELECT AVG(ai_rating) AS avg FROM extracted_links WHERE ai_rating > 0`),
                accountDB.all(`
                    SELECT link_type, COUNT(*) AS cnt
                    FROM   extracted_links WHERE status='active'
                    GROUP BY link_type ORDER BY cnt DESC
                `),
                accountDB.all(`
                    SELECT domain, COUNT(*) AS cnt FROM extracted_links
                    WHERE  status='active' GROUP BY domain ORDER BY cnt DESC LIMIT 5
                `),
                accountDB.get(`
                    SELECT extracted_at FROM extracted_links ORDER BY extracted_at DESC LIMIT 1
                `),
            ]);

            // إحصائيات محرك المراقبة
            const monitorStatus = LinkMonitorEngine.getAccountStatus(accountId);

            res.json({
                success: true,
                stats: {
                    total:          total?.cnt    || 0,
                    spam:           spam?.cnt     || 0,
                    safe:           safe?.cnt     || 0,
                    avgRating:      parseFloat((avgRow?.avg || 0).toFixed(1)),
                    byType:         byType        || [],
                    topDomains:     topDomains    || [],
                    lastDiscovered: recent?.extracted_at || null,
                    monitor:        monitorStatus,
                }
            });
        } catch (error) {
            console.error('GetStats Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  التصنيفات
    // ══════════════════════════════════════════════════════════════════════════
    async getCategories(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const categories = await accountDB.all(`
                SELECT c.*, COUNT(l.id) AS link_count
                FROM   link_categories c
                LEFT JOIN extracted_links l ON l.category_id = c.id
                GROUP BY c.id
                ORDER BY link_count DESC
            `);
            res.json({ success: true, categories });
        } catch (error) {
            console.error('GetCategories Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  حذف رابط
    // ══════════════════════════════════════════════════════════════════════════
    async deleteLink(req, res) {
        try {
            const { accountId, linkId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(`DELETE FROM link_logs WHERE link_id = $1`,         [linkId]);
            await accountDB.run(`DELETE FROM auto_join_queue WHERE link_id = $1`,   [linkId]);
            await accountDB.run(`DELETE FROM extracted_links WHERE id = $1`,        [linkId]);
            res.json({ success: true });
        } catch (error) {
            console.error('DeleteLink Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تغيير حالة الـ Spam
    // ══════════════════════════════════════════════════════════════════════════
    async markSpam(req, res) {
        try {
            const { accountId, linkId } = req.params;
            const { isSpam } = req.body;
            const accountDB  = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `UPDATE extracted_links SET is_spam = $1 WHERE id = $2`,
                [isSpam ? true : false, linkId]
            );
            res.json({ success: true });
        } catch (error) {
            console.error('MarkSpam Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  انضمام تلقائي متقدم — الجزء الثالث
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * POST /accounts/:accountId/links/auto-join/bulk
     * Body: {
     *   linkIds: [...],
     *   joinMode: 'immediate'|'delayed'|'scheduled',
     *   delaySeconds: 10|30|60|300|N,
     *   distributionMode: 'single'|'pair'|'multiple'|'all',
     *   accountIds: [id1, id2, ...],
     *   scheduledAt: '2026-06-10T14:00:00Z' (للمجدول)
     * }
     */
    async bulkAutoJoin(req, res) {
        try {
            const { accountId } = req.params;
            const {
                linkIds          = [],
                joinMode         = 'immediate',
                delaySeconds     = 30,
                distributionMode = 'single',
                accountIds       = [],
                scheduledAt      = null,
            } = req.body;

            if (!linkIds || linkIds.length === 0) {
                return res.status(400).json({ success: false, error: 'لم يتم تحديد أي روابط' });
            }

            // التحقق من صحة وضع الانضمام
            const validModes = ['immediate', 'delayed', 'scheduled'];
            if (!validModes.includes(joinMode)) {
                return res.status(400).json({ success: false, error: 'وضع انضمام غير صالح' });
            }

            const accountDB    = await DatabaseManager.getAccountDB(accountId);
            const placeholders = linkIds.map((_, i) => `$${i + 1}`).join(',');
            const linksData    = await accountDB.all(
                `SELECT id AS linkId, url AS link, link_type FROM extracted_links WHERE id IN (${placeholders})`,
                linkIds
            );

            if (linksData.length === 0) {
                return res.status(404).json({ success: false, error: 'الروابط المحددة غير موجودة' });
            }

            // إضافة accountId الأساسي إذا لم تُحدد قائمة
            const effectiveAccountIds = accountIds.length > 0 ? accountIds : [accountId];

            const count = await GroupJoinerService.scheduleAutoJoin(linksData, {
                joinMode,
                delaySeconds: parseInt(delaySeconds) || 30,
                distributionMode,
                accountIds: effectiveAccountIds,
                scheduledAt,
            });

            // تسجيل الطلب في قاعدة البيانات
            for (const link of linksData) {
                await accountDB.run(
                    `INSERT INTO auto_join_queue (id, link_id, invite_code, status, target_account_id, scheduled_at)
                     VALUES ($1, $2, $3, 'pending', $4, $5)
                     ON CONFLICT DO NOTHING`,
                    [
                        crypto.randomUUID(),
                        link.linkId,
                        link.link?.match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/)?.[1] || null,
                        effectiveAccountIds[0],
                        scheduledAt ? new Date(scheduledAt) : null,
                    ]
                ).catch(() => {});
            }

            const modeLabels = {
                immediate: 'فوري',
                delayed:   `مؤجل ${delaySeconds} ثانية`,
                scheduled: `مجدول في ${scheduledAt ? new Date(scheduledAt).toLocaleString('ar') : ''}`,
            };

            res.json({
                success: true,
                message: `تم جدولة ${count} رابط للانضمام — الوضع: ${modeLabels[joinMode]}`,
                scheduled: count,
                joinMode,
                delaySeconds: parseInt(delaySeconds) || 30,
                distributionMode,
                accountsUsed: effectiveAccountIds.length,
            });

        } catch (error) {
            console.error('BulkAutoJoin Error:', error);
            res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }

    // نقطة توافق مع الكود القديم (للحفاظ على الـ route القديم)
    async autoJoinLinks(req, res) {
        const { accountId } = req.params;
        req.body = {
            linkIds:  req.body.linkIds || [],
            joinMode: 'immediate',
            distributionMode: 'single',
            accountIds: [accountId],
        };
        return this.bulkAutoJoin(req, res);
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  حالة طابور الانضمام
    // ══════════════════════════════════════════════════════════════════════════
    async getJoinQueue(req, res) {
        try {
            const queue = GroupJoinerService.getQueue();
            res.json({ success: true, queue });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async clearJoinQueue(req, res) {
        try {
            GroupJoinerService.clearQueue();
            res.json({ success: true, message: 'تم مسح طابور الانضمام' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  حالة محرك المراقبة
    // ══════════════════════════════════════════════════════════════════════════
    async getMonitorStatus(req, res) {
        try {
            const { accountId } = req.params;
            const status = accountId === 'all'
                ? LinkMonitorEngine.getAllStatus()
                : LinkMonitorEngine.getAccountStatus(accountId);
            res.json({ success: true, status });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تصدير CSV
    // ══════════════════════════════════════════════════════════════════════════
    async exportCSV(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            const links = await accountDB.all(`
                SELECT l.url, l.domain, l.link_type, l.country, l.region, l.keywords,
                       l.ai_rating, l.is_spam, l.extracted_at, c.name AS category
                FROM   extracted_links l
                LEFT JOIN link_categories c ON l.category_id = c.id
                WHERE  l.status = 'active'
                ORDER BY l.extracted_at DESC
                LIMIT 5000
            `);

            const header = 'URL,Domain,Type,Country,Region,Keywords,Rating,IsSpam,Category,Date\n';
            const rows   = links.map(l =>
                [l.url, l.domain, l.link_type, l.country, l.region,
                 `"${(l.keywords||'').replace(/"/g,'""')}"`,
                 l.ai_rating, l.is_spam ? '1' : '0', l.category,
                 l.extracted_at].join(',')
            ).join('\n');

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename=links_${accountId}.csv`);
            res.send('\uFEFF' + header + rows); // BOM for Excel Arabic

        } catch (error) {
            console.error('ExportCSV Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new LinkController();
