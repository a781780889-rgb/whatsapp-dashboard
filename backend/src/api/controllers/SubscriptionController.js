'use strict';
const { v4: uuidv4 } = require('uuid');
const SystemDB = require('../../database/SystemDB');

const PLAN_HOURS = {
    'trial_24h':24, '3d':72, '7d':168, '15d':360,
    '30d':720, '60d':1440, '90d':2160, '180d':4320,
    '365d':8760, 'lifetime': null
};

const PLAN_LABELS = {
    'trial_24h':'تجربة 24 ساعة','3d':'3 أيام','7d':'7 أيام','15d':'15 يوم',
    '30d':'30 يوم','60d':'60 يوم','90d':'90 يوم','180d':'180 يوم',
    '365d':'365 يوم','lifetime':'مدى الحياة'
};

class SubscriptionController {

    _ip(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    }

    /** GET /api/v1/admin/subscriptions */
    async list(req, res) {
        try {
            const { userId, status='', page=1, limit=20 } = req.query;
            const offset = (Number(page)-1)*Number(limit);
            let where = 'WHERE 1=1';
            const params = [];
            if (userId) { params.push(userId); where += ` AND s.user_id=$${params.length}`; }
            if (status) { params.push(status); where += ` AND s.status=$${params.length}`; }

            const subs = await SystemDB.all(`
                SELECT s.*, u.username, u.full_name
                FROM subscriptions s
                LEFT JOIN users u ON u.id=s.user_id
                ${where}
                ORDER BY s.created_at DESC
                LIMIT $1 OFFSET $2`, [...params, Number(limit), offset]);

            const now = Date.now();
            const enriched = subs.map(s => {
                let daysRemaining = -1;
                let isExpired = false;
                if (s.expires_at) {
                    const ms = new Date(s.expires_at) - now;
                    daysRemaining = Math.max(0, Math.ceil(ms/86400000));
                    isExpired = ms <= 0;
                }
                return { ...s, daysRemaining, isExpired, planLabel: PLAN_LABELS[s.plan_type]||s.plan_type };
            });

            const countRow = await SystemDB.get(`SELECT COUNT(*) as cnt FROM subscriptions s ${where}`, params);
            res.json({ success:true, subscriptions: enriched, total: countRow?.cnt||0 });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في جلب الاشتراكات.' });
        }
    }

    /** POST /api/v1/admin/subscriptions — إنشاء أو تجديد */
    async create(req, res) {
        try {
            const { userId, planType, note='' } = req.body || {};
            if (!userId || !planType)
                return res.status(400).json({ success:false, error:'userId و planType مطلوبان.' });
            if (!PLAN_HOURS.hasOwnProperty(planType))
                return res.status(400).json({ success:false, error:'نوع الخطة غير صالح.' });

            const user = await SystemDB.get('SELECT id,username FROM users WHERE id=$1', [userId]);
            if (!user) return res.status(404).json({ success:false, error:'المستخدم غير موجود.' });

            // Expire old active subs
            await SystemDB.run(
                `UPDATE subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'`, [userId]);

            const h = PLAN_HOURS[planType];
            let expiresAt = null;
            if (h !== null) {
                const d = new Date(); d.setHours(d.getHours()+h);
                expiresAt = d.toISOString();
            }

            const subId = uuidv4();
            await SystemDB.run(`INSERT INTO subscriptions (id,user_id,plan_type,expires_at,status,note,created_by)
                VALUES ($1,$2,$3,$4,'active',$5,$6)`,
                [subId, userId, planType, expiresAt, note, req.user.id]);

            await SystemDB.log(req.user.id, req.user.username, 'SUBSCRIPTION_CREATED',
                `${user.username}: ${planType}`, this._ip(req));

            res.status(201).json({ success:true, message:'تم إنشاء الاشتراك.', subscriptionId: subId });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في إنشاء الاشتراك.' });
        }
    }

    /** DELETE /api/v1/admin/subscriptions/:id */
    async cancel(req, res) {
        try {
            await SystemDB.run(`UPDATE subscriptions SET status='cancelled' WHERE id=$1`, [req.params.id]);
            await SystemDB.log(req.user.id, req.user.username, 'SUBSCRIPTION_CANCELLED', req.params.id, this._ip(req));
            res.json({ success:true, message:'تم إلغاء الاشتراك.' });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في إلغاء الاشتراك.' });
        }
    }

    /** GET /api/v1/admin/plans — قائمة الخطط المتاحة */
    async plans(req, res) {
        const plans = Object.entries(PLAN_LABELS).map(([id, label]) => ({
            id, label, hours: PLAN_HOURS[id]
        }));
        res.json({ success:true, plans });
    }
}

module.exports = new SubscriptionController();
