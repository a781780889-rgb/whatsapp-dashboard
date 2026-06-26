'use strict';
/**
 * subscriptionCheck.js — Middleware للتحقق من صلاحية الاشتراك
 * ─────────────────────────────────────────────────────────────
 * يتحقق أن المستخدم (غير الأدمن) لديه اشتراك فعّال غير منتهٍ.
 * إذا انتهى الاشتراك → 403 مع رسالة عربية.
 * الأدمن / super_admin → يمر مباشرة.
 */

const SystemDB = require('../../database/SystemDB');

const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'admin', 'owner']);

module.exports = async (req, res, next) => {
    // السماح للأدمن دون تحقق
    if (ADMIN_ROLES.has(req.user?.role)) return next();

    const userId = req.user?.id;
    if (!userId) {
        return res.status(401).json({ success: false, error: 'غير مصرح.' });
    }

    try {
        const sub = await SystemDB.get(
            `SELECT id, status, expires_at, max_accounts
             FROM subscriptions
             WHERE user_id = $1
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );

        if (!sub || sub.status !== 'active') {
            return res.status(403).json({
                success: false,
                error: 'اشتراكك غير فعّال أو لم يتم إنشاؤه بعد. يرجى التواصل مع المدير لتفعيل الاشتراك.',
                code: 'SUBSCRIPTION_INACTIVE',
            });
        }

        if (sub.expires_at && new Date(sub.expires_at) <= new Date()) {
            return res.status(403).json({
                success: false,
                error: 'انتهت مدة اشتراكك. يرجى التواصل مع المدير لتجديد الاشتراك.',
                code: 'SUBSCRIPTION_EXPIRED',
                expiresAt: sub.expires_at,
            });
        }

        // تمرير بيانات الاشتراك للـ controller
        req.subscription = sub;
        next();

    } catch (err) {
        console.error('[SubscriptionCheck] Error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في التحقق من الاشتراك.' });
    }
};

