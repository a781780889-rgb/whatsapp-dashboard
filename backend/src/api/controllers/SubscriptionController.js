'use strict';
const { v4: uuidv4 } = require('uuid');
const SystemDB = require('../../database/SystemDB');

// ── خطط الاشتراك ────────────────────────────────────────────────────────────
const PLAN_HOURS = {
    'trial_24h': 24,
    'daily':     24,
    '3d':        72,
    'weekly':    168,
    '7d':        168,
    '14d':       336,
    '15d':       360,
    'monthly':   720,
    '30d':       720,
    '60d':       1440,
    'quarterly': 2160,
    '90d':       2160,
    'semi_annual':4320,
    '180d':      4320,
    'annual':    8760,
    '365d':      8760,
    'lifetime':  null
};

const PLAN_LABELS = {
    'trial_24h':   '🕐 تجربة 24 ساعة',
    'daily':       '📅 يومي',
    '3d':          '📅 3 أيام',
    'weekly':      '📆 أسبوعي',
    '7d':          '📆 7 أيام',
    '14d':         '📆 14 يوم',
    '15d':         '📆 15 يوم',
    'monthly':     '🗓️ شهري',
    '30d':         '🗓️ 30 يوم',
    '60d':         '🗓️ 60 يوم',
    'quarterly':   '📊 ربع سنوي',
    '90d':         '📊 90 يوم',
    'semi_annual': '📈 نصف سنوي',
    '180d':        '📈 180 يوم',
    'annual':      '🏆 سنوي',
    '365d':        '🏆 365 يوم',
    'lifetime':    '♾️ مدى الحياة'
};

// الخطط المعروضة في واجهة الإنشاء (مجمّعة ومختصرة)
const DISPLAY_PLANS = [
    { id: 'trial_24h',   label: '🕐 تجربة 24 ساعة',  hours: 24    },
    { id: 'daily',       label: '📅 يومي (24 ساعة)',  hours: 24    },
    { id: '7d',          label: '📆 أسبوعي (7 أيام)', hours: 168   },
    { id: '14d',         label: '📆 أسبوعين (14 يوم)',hours: 336   },
    { id: '30d',         label: '🗓️ شهري (30 يوم)',   hours: 720   },
    { id: '60d',         label: '🗓️ شهران (60 يوم)',  hours: 1440  },
    { id: '90d',         label: '📊 ربع سنوي (90 يوم)',hours: 2160 },
    { id: '180d',        label: '📈 نصف سنوي (180 يوم)',hours: 4320},
    { id: '365d',        label: '🏆 سنوي (365 يوم)',  hours: 8760  },
    { id: 'lifetime',    label: '♾️ مدى الحياة',      hours: null  },
];

// ── Helper ───────────────────────────────────────────────────────────────────
function enrichSub(s) {
    const now = Date.now();
    let daysRemaining = -1;
    let isExpired = false;
    if (s.plan_type === 'lifetime') {
        daysRemaining = Infinity;
    } else if (s.expires_at) {
        const ms = new Date(s.expires_at) - now;
        daysRemaining = Math.max(0, Math.ceil(ms / 86400000));
        isExpired = ms <= 0;
    }
    return {
        ...s,
        daysRemaining,
        isExpired,
        planLabel: PLAN_LABELS[s.plan_type] || s.plan_type
    };
}

class SubscriptionController {

    _ip(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress || 'unknown';
    }

    // ── GET /api/v1/admin/subscriptions ──────────────────────────────────────
    async list(req, res) {
        try {
            const { userId, status = '', planType = '', search = '', page = 1, limit = 20 } = req.query;
            const offset = (Number(page) - 1) * Number(limit);
            const params = [];
            let where = 'WHERE 1=1';

            if (userId)   { params.push(userId);         where += ` AND s.user_id=$${params.length}`; }
            if (status)   { params.push(status);         where += ` AND s.status=$${params.length}`; }
            if (planType) { params.push(planType);       where += ` AND s.plan_type=$${params.length}`; }
            if (search)   { params.push(`%${search}%`); where += ` AND (u.username ILIKE $${params.length} OR u.full_name ILIKE $${params.length})`; }

            const subs = await SystemDB.all(
                `SELECT s.*, u.username, u.full_name, u.email
                 FROM subscriptions s
                 LEFT JOIN users u ON u.id = s.user_id
                 ${where}
                 ORDER BY s.created_at DESC
                 LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
                [...params, Number(limit), offset]
            );

            const countRow = await SystemDB.get(
                `SELECT COUNT(*) as cnt FROM subscriptions s LEFT JOIN users u ON u.id=s.user_id ${where}`,
                params
            );

            res.json({
                success: true,
                subscriptions: subs.map(enrichSub),
                total: parseInt(countRow?.cnt || 0)
            });
        } catch (err) {
            console.error('[SubCtrl] list:', err);
            res.status(500).json({ success: false, error: 'خطأ في جلب الاشتراكات.' });
        }
    }

    // ── POST /api/v1/admin/subscriptions — إنشاء اشتراك ─────────────────────
    async create(req, res) {
        try {
            const { userId, planType, note = '' } = req.body || {};
            if (!userId || !planType)
                return res.status(400).json({ success: false, error: 'userId و planType مطلوبان.' });
            if (!PLAN_HOURS.hasOwnProperty(planType))
                return res.status(400).json({ success: false, error: 'نوع الخطة غير صالح.' });

            const user = await SystemDB.get('SELECT id, username FROM users WHERE id=$1', [userId]);
            if (!user) return res.status(404).json({ success: false, error: 'المستخدم غير موجود.' });

            // إلغاء الاشتراكات النشطة السابقة
            await SystemDB.run(
                `UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE user_id=$1 AND status='active'`,
                [userId]
            );

            const h = PLAN_HOURS[planType];
            let expiresAt = null;
            if (h !== null) {
                const d = new Date();
                d.setHours(d.getHours() + h);
                expiresAt = d.toISOString();
            }

            const subId = uuidv4();
            await SystemDB.run(
                `INSERT INTO subscriptions (id, user_id, plan_type, started_at, expires_at, status, note, created_by)
                 VALUES ($1, $2, $3, NOW(), $4, 'active', $5, $6)`,
                [subId, userId, planType, expiresAt, note, req.user.id]
            );

            await SystemDB.log(
                req.user.id, req.user.username,
                'SUBSCRIPTION_CREATED',
                `${user.username}: ${PLAN_LABELS[planType] || planType}`,
                this._ip(req)
            );

            res.status(201).json({
                success: true,
                message: 'تم إنشاء الاشتراك بنجاح.',
                subscriptionId: subId
            });
        } catch (err) {
            console.error('[SubCtrl] create:', err);
            res.status(500).json({ success: false, error: 'خطأ في إنشاء الاشتراك.' });
        }
    }

    // ── POST /api/v1/admin/subscriptions/:id/extend — تمديد ─────────────────
    async extend(req, res) {
        try {
            const { extraDays, extraHours, note = '' } = req.body || {};
            const totalHours = (Number(extraDays || 0) * 24) + Number(extraHours || 0);
            if (!totalHours || totalHours <= 0)
                return res.status(400).json({ success: false, error: 'يجب تحديد عدد الأيام أو الساعات للتمديد.' });

            const newExpiry = await SystemDB.extendSubscription(
                req.params.id, totalHours, req.user.id, req.user.username, note, this._ip(req)
            );

            res.json({
                success: true,
                message: `تم تمديد الاشتراك بـ ${totalHours} ساعة.`,
                newExpiresAt: newExpiry.toISOString()
            });
        } catch (err) {
            console.error('[SubCtrl] extend:', err);
            res.status(400).json({ success: false, error: err.message || 'خطأ في تمديد الاشتراك.' });
        }
    }

    // ── PATCH /api/v1/admin/subscriptions/:id/freeze — تجميد ────────────────
    async freeze(req, res) {
        try {
            const { note = '' } = req.body || {};
            await SystemDB.freezeSubscription(
                req.params.id, req.user.id, req.user.username, note, this._ip(req)
            );
            res.json({ success: true, message: 'تم تجميد الاشتراك.' });
        } catch (err) {
            console.error('[SubCtrl] freeze:', err);
            res.status(400).json({ success: false, error: err.message || 'خطأ في تجميد الاشتراك.' });
        }
    }

    // ── PATCH /api/v1/admin/subscriptions/:id/activate — تفعيل ─────────────
    async activate(req, res) {
        try {
            const { note = '' } = req.body || {};
            await SystemDB.activateSubscription(
                req.params.id, req.user.id, req.user.username, note, this._ip(req)
            );
            res.json({ success: true, message: 'تم تفعيل الاشتراك.' });
        } catch (err) {
            console.error('[SubCtrl] activate:', err);
            res.status(400).json({ success: false, error: err.message || 'خطأ في تفعيل الاشتراك.' });
        }
    }

    // ── DELETE /api/v1/admin/subscriptions/:id — إلغاء ──────────────────────
    async cancel(req, res) {
        try {
            await SystemDB.run(
                `UPDATE subscriptions SET status='cancelled', updated_at=NOW() WHERE id=$1`,
                [req.params.id]
            );
            await SystemDB.log(
                req.user.id, req.user.username,
                'SUBSCRIPTION_CANCELLED', req.params.id, this._ip(req)
            );
            res.json({ success: true, message: 'تم إلغاء الاشتراك.' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'خطأ في إلغاء الاشتراك.' });
        }
    }

    // ── DELETE /api/v1/admin/subscriptions/:id/permanent — حذف نهائي ────────
    async deletePermanent(req, res) {
        try {
            await SystemDB.run(`DELETE FROM subscriptions WHERE id=$1`, [req.params.id]);
            await SystemDB.log(
                req.user.id, req.user.username,
                'SUBSCRIPTION_DELETED', req.params.id, this._ip(req)
            );
            res.json({ success: true, message: 'تم حذف الاشتراك نهائياً.' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'خطأ في حذف الاشتراك.' });
        }
    }

    // ── GET /api/v1/admin/subscriptions/stats — إحصائيات ────────────────────
    async stats(req, res) {
        try {
            const data = await SystemDB.getSubscriptionStats();
            res.json({ success: true, stats: data });
        } catch (err) {
            console.error('[SubCtrl] stats:', err);
            res.status(500).json({ success: false, error: 'خطأ في جلب الإحصائيات.' });
        }
    }

    // ── GET /api/v1/admin/subscriptions/export — تصدير CSV ──────────────────
    async exportCSV(req, res) {
        try {
            const subs = await SystemDB.all(
                `SELECT s.id, u.username, u.full_name, u.email,
                        s.plan_type, s.status, s.started_at, s.expires_at,
                        s.note, s.created_at
                 FROM subscriptions s
                 LEFT JOIN users u ON u.id = s.user_id
                 ORDER BY s.created_at DESC`
            );

            const header = 'ID,اسم المستخدم,الاسم الكامل,البريد,الخطة,الحالة,بداية,انتهاء,ملاحظة,تاريخ الإنشاء\n';
            const rows = subs.map(s => [
                s.id,
                s.username || '',
                s.full_name || '',
                s.email || '',
                PLAN_LABELS[s.plan_type] || s.plan_type,
                s.status,
                s.started_at ? new Date(s.started_at).toLocaleDateString('ar') : '',
                s.expires_at ? new Date(s.expires_at).toLocaleDateString('ar') : 'مدى الحياة',
                (s.note || '').replace(/,/g, '؛'),
                new Date(s.created_at).toLocaleDateString('ar')
            ].map(v => `"${v}"`).join(','));

            const csv = '\uFEFF' + header + rows.join('\n'); // BOM للعربية
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="subscriptions-${Date.now()}.csv"`);
            res.send(csv);
        } catch (err) {
            console.error('[SubCtrl] export:', err);
            res.status(500).json({ success: false, error: 'خطأ في تصدير الاشتراكات.' });
        }
    }

    // ── GET /api/v1/admin/plans — قائمة الخطط ───────────────────────────────
    async plans(req, res) {
        res.json({ success: true, plans: DISPLAY_PLANS });
    }

    // ── GET /api/v1/admin/subscriptions/:id/renewals — سجل التجديدات ─────────
    async renewals(req, res) {
        try {
            const rows = await SystemDB.all(
                `SELECT r.*, u.username as admin_username
                 FROM subscription_renewals r
                 LEFT JOIN users u ON u.id = r.action_by
                 WHERE r.subscription_id = $1
                 ORDER BY r.created_at DESC`,
                [req.params.id]
            );
            res.json({ success: true, renewals: rows });
        } catch (err) {
            res.status(500).json({ success: false, error: 'خطأ في جلب سجل التجديدات.' });
        }
    }
}

module.exports = new SubscriptionController();
