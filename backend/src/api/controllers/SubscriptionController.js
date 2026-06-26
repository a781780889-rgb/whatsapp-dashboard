'use strict';
/**
 * SubscriptionController — إدارة الاشتراكات (Multi-Tenant SaaS)
 * ─────────────────────────────────────────────────────────────────
 * Admin Routes:
 *   POST   /api/v1/admin/subscriptions            — إنشاء مشترك جديد
 *   GET    /api/v1/admin/subscriptions            — قائمة المشتركين
 *   GET    /api/v1/admin/subscriptions/:id        — تفاصيل مشترك
 *   PATCH  /api/v1/admin/subscriptions/:id        — تعديل اشتراك
 *   POST   /api/v1/admin/subscriptions/:id/extend — تمديد اشتراك
 *   PATCH  /api/v1/admin/subscriptions/:id/status — تغيير حالة
 *   DELETE /api/v1/admin/subscriptions/:id        — حذف مشترك
 *
 * User Routes:
 *   GET    /api/v1/subscription/me                — بيانات اشتراكي
 */

const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const SystemDB = require('../../database/SystemDB');

// ── مدد الاشتراك المدعومة ─────────────────────────────────────────────────────
const DURATION_MAP = {
    day:      { hours: 24,    label: 'يوم واحد' },
    month:    { hours: 720,   label: 'شهر واحد' },
    '2months':{ hours: 1440,  label: 'شهران' },
    '3months':{ hours: 2160,  label: '3 أشهر' },
    year:     { hours: 8760,  label: 'سنة كاملة' },
};

// ── عدد الحسابات المسموح ──────────────────────────────────────────────────────
const ACCOUNT_LIMITS = [1, 2, 3, 4, 5, 6, 7, -1]; // -1 = unlimited

function calcExpiry(duration) {
    const entry = DURATION_MAP[duration];
    if (!entry) throw new Error(`مدة غير صالحة: ${duration}`);
    const ms = entry.hours * 3600 * 1000;
    return new Date(Date.now() + ms).toISOString();
}

class SubscriptionController {

    // ══════════════════════════════════════════════════════
    //  ADMIN — إنشاء مشترك جديد
    // ══════════════════════════════════════════════════════
    async createSubscriber(req, res) {
        const {
            username, password, fullName,
            duration, maxAccounts, enableTelegram,
        } = req.body || {};

        // ── التحقق من البيانات ────────────────────────────────────────────────
        if (!username || !password || !duration || maxAccounts === undefined) {
            return res.status(400).json({
                success: false,
                error: 'الحقول المطلوبة: username, password, duration, maxAccounts',
            });
        }

        if (!DURATION_MAP[duration]) {
            return res.status(400).json({
                success: false,
                error: `مدة غير صالحة. الخيارات: ${Object.keys(DURATION_MAP).join(', ')}`,
            });
        }

        const maxAcc = parseInt(maxAccounts, 10);
        if (!ACCOUNT_LIMITS.includes(maxAcc)) {
            return res.status(400).json({
                success: false,
                error: `عدد الحسابات غير صالح. الخيارات: ${ACCOUNT_LIMITS.join(', ')} (-1 = unlimited)`,
            });
        }

        if (password.length < 6) {
            return res.status(400).json({ success: false, error: 'كلمة المرور يجب أن تكون 6 أحرف على الأقل.' });
        }

        try {
            // ── تحقق من التكرار ───────────────────────────────────────────────
            const existing = await SystemDB.get(`SELECT id FROM users WHERE username = $1`, [username]);
            if (existing) {
                return res.status(409).json({ success: false, error: 'اسم المستخدم مستخدم بالفعل.' });
            }

            const userId      = uuidv4();
            const subId       = uuidv4();
            const passwordHash = await bcrypt.hash(password, 12);
            const expiresAt   = calcExpiry(duration);

            // ── إنشاء المستخدم ────────────────────────────────────────────────
            await SystemDB.run(
                `INSERT INTO users (id, username, password, full_name, role, status)
                 VALUES ($1, $2, $3, $4, 'user', 'active')`,
                [userId, username.trim(), passwordHash, fullName || username]
            );

            // ── إنشاء الاشتراك ─────────────────────────────────────────────────
            await SystemDB.run(
                `INSERT INTO subscriptions (id, user_id, plan_type, status, max_accounts, expires_at, enable_telegram)
                 VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
                [subId, userId, duration, maxAcc, expiresAt, enableTelegram === true]
            );

            await SystemDB.log(req.user.id, req.user.username, 'CREATE_SUBSCRIBER',
                `Created subscriber: ${username}, duration: ${duration}, maxAccounts: ${maxAcc}`,
                req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            );

            return res.status(201).json({
                success: true,
                message: 'تم إنشاء المشترك بنجاح.',
                subscriber: {
                    userId,
                    subscriptionId: subId,
                    username,
                    fullName: fullName || username,
                    duration,
                    maxAccounts: maxAcc,
                    expiresAt,
                    status: 'active',
                },
            });

        } catch (err) {
            console.error('[SubscriptionCtrl] createSubscriber:', err);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN — قائمة المشتركين مع إحصائيات
    // ══════════════════════════════════════════════════════
    async listSubscribers(req, res) {
        const { search = '', page = 1, limit = 30 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        try {
            const searchParam = search ? `%${search}%` : null;
            const whereClause = searchParam
                ? `WHERE u.username ILIKE $1 OR u.full_name ILIKE $1`
                : '';

            const params = searchParam
                ? [searchParam, Number(limit), offset]
                : [Number(limit), offset];

            const limitIdx  = searchParam ? 2 : 1;
            const offsetIdx = searchParam ? 3 : 2;

            const rows = await SystemDB.all(`
                SELECT
                    u.id          AS user_id,
                    u.username,
                    u.full_name,
                    u.status      AS user_status,
                    u.last_login,
                    u.created_at  AS user_created_at,
                    s.id          AS subscription_id,
                    s.plan_type   AS duration,
                    s.status      AS sub_status,
                    s.max_accounts,
                    s.expires_at,
                    s.enable_telegram,
                    s.created_at  AS sub_created_at,
                    (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS used_accounts
                FROM users u
                LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
                ${whereClause}
                ORDER BY u.created_at DESC
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `, params);

            const countRow = await SystemDB.get(
                `SELECT COUNT(*) as cnt FROM users u ${whereClause}`,
                searchParam ? [searchParam] : []
            );

            // إضافة حقل الحسابات المتبقية وحالة الانتهاء
            const enriched = rows.map(r => {
                const isExpired = r.expires_at && new Date(r.expires_at) < new Date();
                const daysRemaining = r.expires_at
                    ? Math.max(0, Math.ceil((new Date(r.expires_at) - Date.now()) / 86400000))
                    : null;
                const usedAccounts = parseInt(r.used_accounts, 10) || 0;
                const maxAccounts  = r.max_accounts === -1 ? null : r.max_accounts;
                const remaining    = maxAccounts === null ? null : Math.max(0, maxAccounts - usedAccounts);

                return {
                    ...r,
                    isExpired,
                    daysRemaining,
                    usedAccounts,
                    maxAccounts,
                    remainingAccounts: remaining,
                };
            });

            return res.json({
                success: true,
                subscribers: enriched,
                total: parseInt(countRow?.cnt || 0, 10),
                page: Number(page),
                limit: Number(limit),
            });

        } catch (err) {
            console.error('[SubscriptionCtrl] listSubscribers:', err);
            return res.status(500).json({ success: false, error: 'خطأ في جلب المشتركين.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN — تفاصيل مشترك واحد
    // ══════════════════════════════════════════════════════
    async getSubscriber(req, res) {
        const { id } = req.params;
        try {
            const row = await SystemDB.get(`
                SELECT
                    u.id          AS user_id,
                    u.username,
                    u.full_name,
                    u.status      AS user_status,
                    u.last_login,
                    u.created_at  AS user_created_at,
                    s.id          AS subscription_id,
                    s.plan_type   AS duration,
                    s.status      AS sub_status,
                    s.max_accounts,
                    s.expires_at,
                    s.enable_telegram,
                    s.created_at  AS sub_created_at,
                    (SELECT COUNT(*) FROM accounts a WHERE a.user_id = u.id) AS used_accounts
                FROM users u
                LEFT JOIN subscriptions s ON s.user_id = u.id AND s.status = 'active'
                WHERE u.id = $1
            `, [id]);

            if (!row) return res.status(404).json({ success: false, error: 'المشترك غير موجود.' });

            const isExpired     = row.expires_at && new Date(row.expires_at) < new Date();
            const daysRemaining = row.expires_at
                ? Math.max(0, Math.ceil((new Date(row.expires_at) - Date.now()) / 86400000))
                : null;
            const usedAccounts  = parseInt(row.used_accounts, 10) || 0;
            const maxAccounts   = row.max_accounts === -1 ? null : row.max_accounts;
            const remaining     = maxAccounts === null ? null : Math.max(0, maxAccounts - usedAccounts);

            // سجل النشاط الأخير
            const recentLogs = await SystemDB.all(
                `SELECT action, details, created_at FROM activity_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 10`,
                [id]
            );

            // قائمة الحسابات
            const accounts = await SystemDB.all(
                `SELECT id, name, phone_number, status, created_at FROM accounts WHERE user_id=$1 ORDER BY created_at DESC`,
                [id]
            );

            return res.json({
                success: true,
                subscriber: {
                    ...row,
                    isExpired,
                    daysRemaining,
                    usedAccounts,
                    maxAccounts,
                    remainingAccounts: remaining,
                    recentLogs,
                    accounts,
                },
            });

        } catch (err) {
            console.error('[SubscriptionCtrl] getSubscriber:', err);
            return res.status(500).json({ success: false, error: 'خطأ في جلب المشترك.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN — تعديل اشتراك
    // ══════════════════════════════════════════════════════
    async updateSubscriber(req, res) {
        const { id } = req.params;
        const { fullName, password, maxAccounts, duration, enableTelegram } = req.body || {};

        try {
            const user = await SystemDB.get(`SELECT id FROM users WHERE id=$1`, [id]);
            if (!user) return res.status(404).json({ success: false, error: 'المشترك غير موجود.' });

            // تحديث بيانات المستخدم
            if (fullName) {
                await SystemDB.run(`UPDATE users SET full_name=$1, updated_at=NOW() WHERE id=$2`, [fullName, id]);
            }
            if (password) {
                if (password.length < 6) return res.status(400).json({ success: false, error: 'كلمة المرور قصيرة جداً.' });
                const hash = await bcrypt.hash(password, 12);
                await SystemDB.run(`UPDATE users SET password=$1, updated_at=NOW() WHERE id=$2`, [hash, id]);
            }

            // تحديث الاشتراك
            const sub = await SystemDB.get(`SELECT id FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]);
            if (sub) {
                if (maxAccounts !== undefined) {
                    const maxAcc = parseInt(maxAccounts, 10);
                    if (!ACCOUNT_LIMITS.includes(maxAcc)) {
                        return res.status(400).json({ success: false, error: 'عدد الحسابات غير صالح.' });
                    }
                    await SystemDB.run(`UPDATE subscriptions SET max_accounts=$1, updated_at=NOW() WHERE id=$2`, [maxAcc, sub.id]);
                }
                if (enableTelegram !== undefined) {
                    await SystemDB.run(`UPDATE subscriptions SET enable_telegram=$1, updated_at=NOW() WHERE id=$2`, [enableTelegram === true, sub.id]);
                }
                if (duration) {
                    if (!DURATION_MAP[duration]) return res.status(400).json({ success: false, error: 'مدة غير صالحة.' });
                    const expiresAt = calcExpiry(duration);
                    await SystemDB.run(
                        `UPDATE subscriptions SET plan_type=$1, expires_at=$2, updated_at=NOW() WHERE id=$3`,
                        [duration, expiresAt, sub.id]
                    );
                }
            }

            await SystemDB.log(req.user.id, req.user.username, 'UPDATE_SUBSCRIBER', `userId: ${id}`,
                req.headers['x-forwarded-for'] || req.socket?.remoteAddress);

            return res.json({ success: true, message: 'تم تحديث بيانات المشترك.' });

        } catch (err) {
            console.error('[SubscriptionCtrl] updateSubscriber:', err);
            return res.status(500).json({ success: false, error: 'خطأ في تحديث المشترك.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN — تمديد اشتراك
    // ══════════════════════════════════════════════════════
    async extendSubscription(req, res) {
        const { id } = req.params;
        const { duration, note } = req.body || {};

        if (!duration || !DURATION_MAP[duration]) {
            return res.status(400).json({
                success: false,
                error: `مدة غير صالحة. الخيارات: ${Object.keys(DURATION_MAP).join(', ')}`,
            });
        }

        try {
            const sub = await SystemDB.get(
                `SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]
            );
            if (!sub) return res.status(404).json({ success: false, error: 'لا يوجد اشتراك لهذا المستخدم.' });

            // التمديد من الآن أو من نهاية الاشتراك الحالي (أيهما أكبر)
            const base    = sub.expires_at && new Date(sub.expires_at) > new Date()
                ? new Date(sub.expires_at)
                : new Date();
            const hours   = DURATION_MAP[duration].hours;
            const newExp  = new Date(base.getTime() + hours * 3600 * 1000).toISOString();

            await SystemDB.run(
                `UPDATE subscriptions SET status='active', plan_type=$1, expires_at=$2, updated_at=NOW() WHERE id=$3`,
                [duration, newExp, sub.id]
            );

            // سجل التمديد
            await SystemDB.run(
                `INSERT INTO subscription_renewals (id, subscription_id, plan_type, extended_hours, note)
                 VALUES ($1, $2, $3, $4, $5)`,
                [uuidv4(), sub.id, duration, hours, note || null]
            );

            await SystemDB.log(req.user.id, req.user.username, 'EXTEND_SUBSCRIPTION',
                `userId: ${id}, duration: ${duration}, newExpiry: ${newExp}`,
                req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            );

            return res.json({
                success: true,
                message: `تم تمديد الاشتراك بـ ${DURATION_MAP[duration].label}.`,
                newExpiresAt: newExp,
            });

        } catch (err) {
            console.error('[SubscriptionCtrl] extendSubscription:', err);
            return res.status(500).json({ success: false, error: 'خطأ في تمديد الاشتراك.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN — تغيير حالة الاشتراك (تفعيل / إيقاف)
    // ══════════════════════════════════════════════════════
    async setSubscriptionStatus(req, res) {
        const { id } = req.params;
        const { status } = req.body || {};

        const validStatuses = ['active', 'suspended', 'cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, error: `حالة غير صالحة. الخيارات: ${validStatuses.join(', ')}` });
        }

        try {
            // تحديث حالة الاشتراك
            await SystemDB.run(
                `UPDATE subscriptions SET status=$1, updated_at=NOW() WHERE user_id=$2`,
                [status, id]
            );

            // تحديث حالة المستخدم
            const userStatus = status === 'active' ? 'active' : 'suspended';
            await SystemDB.run(`UPDATE users SET status=$1, updated_at=NOW() WHERE id=$2`, [userStatus, id]);

            // إبطال جميع tokens إذا تم الإيقاف
            if (status !== 'active') {
                await SystemDB.revokeAllUserTokens(id).catch(() => {});
            }

            await SystemDB.log(req.user.id, req.user.username, 'SET_SUBSCRIPTION_STATUS',
                `userId: ${id}, status: ${status}`,
                req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            );

            return res.json({ success: true, message: `تم تغيير حالة الاشتراك إلى: ${status}` });

        } catch (err) {
            console.error('[SubscriptionCtrl] setSubscriptionStatus:', err);
            return res.status(500).json({ success: false, error: 'خطأ في تغيير حالة الاشتراك.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  ADMIN — حذف مشترك
    // ══════════════════════════════════════════════════════
    async deleteSubscriber(req, res) {
        const { id } = req.params;

        try {
            const user = await SystemDB.get(`SELECT id, username FROM users WHERE id=$1`, [id]);
            if (!user) return res.status(404).json({ success: false, error: 'المشترك غير موجود.' });

            // إبطال tokens
            await SystemDB.revokeAllUserTokens(id).catch(() => {});

            // حذف البيانات المرتبطة
            await SystemDB.run(`DELETE FROM subscription_renewals WHERE subscription_id IN (SELECT id FROM subscriptions WHERE user_id=$1)`, [id]);
            await SystemDB.run(`DELETE FROM subscriptions WHERE user_id=$1`, [id]);
            await SystemDB.run(`DELETE FROM refresh_tokens WHERE user_id=$1`, [id]);
            await SystemDB.run(`DELETE FROM activity_logs WHERE user_id=$1`, [id]);

            // حذف حسابات الواتساب
            const accounts = await SystemDB.all(`SELECT id FROM accounts WHERE user_id=$1`, [id]);
            for (const acc of accounts) {
                await SystemDB.run(`DELETE FROM session_data WHERE account_id=$1`, [acc.id]).catch(() => {});
            }
            await SystemDB.run(`DELETE FROM accounts WHERE user_id=$1`, [id]);

            // حذف المستخدم
            await SystemDB.run(`DELETE FROM users WHERE id=$1`, [id]);

            await SystemDB.log(req.user.id, req.user.username, 'DELETE_SUBSCRIBER',
                `Deleted: ${user.username}`,
                req.headers['x-forwarded-for'] || req.socket?.remoteAddress
            );

            return res.json({ success: true, message: 'تم حذف المشترك وجميع بياناته.' });

        } catch (err) {
            console.error('[SubscriptionCtrl] deleteSubscriber:', err);
            return res.status(500).json({ success: false, error: 'خطأ في حذف المشترك.' });
        }
    }

    // ══════════════════════════════════════════════════════
    //  USER — بيانات اشتراكي الخاص
    // ══════════════════════════════════════════════════════
    async mySubscription(req, res) {
        const userId = req.user.id;
        try {
            const sub = await SystemDB.get(`
                SELECT id, plan_type, status, max_accounts, expires_at, created_at, enable_telegram
                FROM subscriptions
                WHERE user_id=$1 AND status='active'
                ORDER BY created_at DESC LIMIT 1
            `, [userId]);

            const usedAccounts = await SystemDB.get(
                `SELECT COUNT(*) as cnt FROM accounts WHERE user_id=$1`, [userId]
            );

            const used       = parseInt(usedAccounts?.cnt || 0, 10);
            const maxAcc     = sub?.max_accounts ?? 0;
            const isUnlimited = maxAcc === -1;

            let daysRemaining = null;
            let isExpired     = false;

            if (sub?.expires_at) {
                const ms = new Date(sub.expires_at) - Date.now();
                daysRemaining = Math.max(0, Math.ceil(ms / 86400000));
                isExpired     = ms <= 0;
            }

            return res.json({
                success: true,
                subscription: sub
                    ? {
                        id:              sub.id,
                        duration:        sub.plan_type,
                        status:          isExpired ? 'expired' : sub.status,
                        maxAccounts:     isUnlimited ? null : maxAcc,
                        isUnlimited,
                        usedAccounts:    used,
                        remainingAccounts: isUnlimited ? null : Math.max(0, maxAcc - used),
                        expiresAt:       sub.expires_at,
                        daysRemaining,
                        isExpired,
                        createdAt:       sub.created_at,
                        enableTelegram:  sub.enable_telegram === true,
                    }
                    : null,
            });

        } catch (err) {
            console.error('[SubscriptionCtrl] mySubscription:', err);
            return res.status(500).json({ success: false, error: 'خطأ في جلب بيانات الاشتراك.' });
        }
    }
}

module.exports = new SubscriptionController();
