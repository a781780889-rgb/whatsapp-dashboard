const DatabaseManager = require('../../database/DatabaseManager');
const GroupJoinerService = require('../services/GroupJoinerService');

class LinkController {

    async getLinks(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            
            const limit       = parseInt(req.query.limit)      || 100;
            const status      = req.query.status               || 'active';
            const search      = req.query.search               || null;
            const categoryId  = req.query.categoryId           || null;
            const minRating   = parseInt(req.query.minRating)  || 0;
            const hideSpam    = req.query.hideSpam === 'true';
            const spamOnly    = req.query.spamOnly === 'true';
            const dateFrom    = req.query.dateFrom             || null;
            const dateTo      = req.query.dateTo               || null;
            const sortBy      = ['extracted_at','ai_rating','domain'].includes(req.query.sortBy) ? req.query.sortBy : 'extracted_at';
            const sortDir     = req.query.sortDir === 'ASC'    ? 'ASC' : 'DESC';

            let query = `
                SELECT l.*, c.name AS category_name, c.color AS category_color
                FROM extracted_links l
                LEFT JOIN link_categories c ON l.category_id = c.id
                WHERE l.status = $1
            `;
            let params = [status];

            // Geo & Keywords Filtering
            if (req.query.country) {
                query += ` AND l.country = ?`;
                params.push(req.query.country);
            }
            if (req.query.region) {
                query += ` AND l.region = ?`;
                params.push(req.query.region);
            }

            // --- Filters ---
            if (search) {
                // Multi-keyword: space-separated terms → each must appear in url OR domain
                const terms = search.trim().split(/\s+/);
                for (const term of terms) {
                    query += ` AND (l.url LIKE ? OR l.domain LIKE ?)`;
                    params.push(`%${term}%`, `%${term}%`);
                }
            }

            if (categoryId) {
                query += ` AND l.category_id = ?`;
                params.push(categoryId);
            }

            if (minRating > 0) {
                query += ` AND l.ai_rating >= ?`;
                params.push(minRating);
            }

            if (hideSpam) {
                query += ` AND l.is_spam = 0`;
            }

            if (spamOnly) {
                query += ` AND l.is_spam = 1`;
            }

            if (dateFrom) {
                query += ` AND l.extracted_at >= ?`;
                params.push(dateFrom);
            }

            if (dateTo) {
                query += ` AND l.extracted_at <= ?`;
                params.push(dateTo + ' 23:59:59');
            }

            query += ` ORDER BY l.${sortBy} ${sortDir} LIMIT ?`;
            params.push(limit);

            const links = await accountDB.all(query, params);
            res.json({ success: true, links, count: links.length });

        } catch (error) {
            console.error('GetLinks Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getStats(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            const totalRow    = await accountDB.get(`SELECT COUNT(*) as cnt FROM extracted_links WHERE status='active'`);
            const spamRow     = await accountDB.get(`SELECT COUNT(*) as cnt FROM extracted_links WHERE is_spam=1`);
            const safeRow     = await accountDB.get(`SELECT COUNT(*) as cnt FROM extracted_links WHERE is_spam=0 AND status='active'`);
            const avgRatingRow = await accountDB.get(`SELECT AVG(ai_rating) as avg FROM extracted_links WHERE ai_rating > 0`);
            const topDomainsRows = await accountDB.all(`
                SELECT domain, COUNT(*) as cnt FROM extracted_links 
                WHERE status='active' GROUP BY domain ORDER BY cnt DESC LIMIT 5
            `);

            res.json({
                success: true,
                stats: {
                    total: totalRow?.cnt || 0,
                    spam: spamRow?.cnt || 0,
                    safe: safeRow?.cnt || 0,
                    avgRating: parseFloat((avgRatingRow?.avg || 0).toFixed(1)),
                    topDomains: topDomainsRows || []
                }
            });
        } catch (error) {
            console.error('GetStats Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getCategories(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            
            const categories = await accountDB.all(`
                SELECT c.*, COUNT(l.id) as link_count 
                FROM link_categories c 
                LEFT JOIN extracted_links l ON l.category_id = c.id
                GROUP BY c.id ORDER BY link_count DESC
            `);
            res.json({ success: true, categories });
        } catch (error) {
            console.error('GetCategories Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async deleteLink(req, res) {
        try {
            const { accountId, linkId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            
            await accountDB.run(`DELETE FROM link_logs WHERE link_id = $1`, [linkId]);
            await accountDB.run(`DELETE FROM extracted_links WHERE id = $1`, [linkId]);
            
            res.json({ success: true });
        } catch (error) {
            console.error('DeleteLink Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async markSpam(req, res) {
        try {
            const { accountId, linkId } = req.params;
            const { isSpam } = req.body;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            await accountDB.run(
                `UPDATE extracted_links SET is_spam = $1 WHERE id = $2`,
                [isSpam ? 1 : 0, linkId]
            );
            res.json({ success: true });
        } catch (error) {
            console.error('MarkSpam Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async autoJoinLinks(req, res) {
        try {
            const { accountId } = req.params;
            const { linkIds } = req.body; // Array of UUIDs from the dashboard

            if (!linkIds || linkIds.length === 0) {
                return res.status(400).json({ success: false, error: 'No links provided' });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            
            // Retrieve the actual URLs
            const placeholders = linkIds.map(() => '?').join(',');
            const linksData = await accountDB.all(
                `SELECT id as linkId, url FROM extracted_links WHERE id IN (${placeholders})`,
                linkIds
            );

            if (linksData.length === 0) {
                return res.status(404).json({ success: false, error: 'Links not found' });
            }

            // Send to GroupJoinerService for smart balancing and scheduling
            const scheduledCount = await GroupJoinerService.scheduleAutoJoin(linksData);

            res.json({ success: true, message: `Successfully scheduled ${scheduledCount} group joins.` });
        } catch (error) {
            console.error('AutoJoin Error:', error);
            res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }
}

module.exports = new LinkController();
