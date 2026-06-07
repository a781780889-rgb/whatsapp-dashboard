'use strict';
const SystemDB = require('../../database/SystemDB');

class AdminController {

    /** GET /api/v1/admin/stats */
    async stats(req, res) {
        try {
            const now = new Date().toISOString();

            const [
                totalUsers, activeUsers, suspendedUsers,
                expiredSubs, trialSubs, lifetimeSubs,
                totalAccounts, activeAccounts,
                recentLogs, loginsFailed
            ] = await Promise.all([
                SystemDB.get('SELECT COUNT(*) as cnt FROM users'),
                SystemDB.get("SELECT COUNT(*) as cnt FROM users WHERE status='active'"),
                SystemDB.get("SELECT COUNT(*) as cnt FROM users WHERE status='suspended'"),
                SystemDB.get(`SELECT COUNT(DISTINCT user_id) as cnt FROM subscriptions
                    WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= $1`, [now]),
                SystemDB.get("SELECT COUNT(*) as cnt FROM subscriptions WHERE plan_type='trial_24h' AND status='active'"),
                SystemDB.get("SELECT COUNT(*) as cnt FROM subscriptions WHERE plan_type='lifetime' AND status='active'"),
                SystemDB.get('SELECT COUNT(*) as cnt FROM accounts'),
                SystemDB.get("SELECT COUNT(*) as cnt FROM accounts WHERE status='connected'"),
                SystemDB.all(`SELECT username, action, created_at, ip_address
                    FROM activity_logs ORDER BY created_at DESC LIMIT 20`),
                SystemDB.get(`SELECT COUNT(*) as cnt FROM login_attempts
                    WHERE success=0 AND created_at > datetime('now','-24 hours')`)
            ]);

            // Subscriptions breakdown by plan
            const planBreakdown = await SystemDB.all(`
                SELECT plan_type, COUNT(*) as cnt
                FROM subscriptions WHERE status='active'
                GROUP BY plan_type`);

            // Users created per day (last 7 days)
            const userGrowth = await SystemDB.all(`
                SELECT date(created_at) as day, COUNT(*) as cnt
                FROM users
                WHERE created_at > datetime('now','-7 days')
                GROUP BY day ORDER BY day ASC`);

            res.json({
                success: true,
                stats: {
                    users: {
                        total: totalUsers?.cnt||0,
                        active: activeUsers?.cnt||0,
                        suspended: suspendedUsers?.cnt||0,
                        expired: expiredSubs?.cnt||0
                    },
                    subscriptions: {
                        trial: trialSubs?.cnt||0,
                        lifetime: lifetimeSubs?.cnt||0,
                        planBreakdown
                    },
                    accounts: {
                        total: totalAccounts?.cnt||0,
                        active: activeAccounts?.cnt||0
                    },
                    security: {
                        failedLogins24h: loginsFailed?.cnt||0
                    },
                    recentActivity: recentLogs,
                    userGrowth
                }
            });
        } catch(err) {
            console.error('[AdminCtrl] stats:', err);
            res.status(500).json({ success:false, error:'خطأ في جلب الإحصائيات.' });
        }
    }

    /** GET /api/v1/admin/activity-logs */
    async activityLogs(req, res) {
        try {
            const { userId, action='', page=1, limit=50 } = req.query;
            const offset = (Number(page)-1)*Number(limit);
            let where = 'WHERE 1=1';
            const params = [];
            if (userId) { params.push(userId);          where += ` AND user_id=$${params.length}`; }
            if (action) { params.push(`%${action}%`); where += ` AND action LIKE $${params.length}`; }

            const logs = await SystemDB.all(`
                SELECT * FROM activity_logs ${where}
                ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [...params, Number(limit), offset]);
            const countRow = await SystemDB.get(`SELECT COUNT(*) as cnt FROM activity_logs ${where}`, params);

            res.json({ success:true, logs, total: countRow?.cnt||0 });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في جلب السجلات.' });
        }
    }
}

module.exports = new AdminController();
