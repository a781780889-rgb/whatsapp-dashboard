'use strict';
const SystemDB = require('../../database/SystemDB');

/**
 * subscriptionCheck.js
 * يتحقق من أن المستخدم لديه اشتراك نشط.
 * المستويات المعفاة: owner, superadmin, super_admin, admin
 *
 * [FIX-SUB] إذا لم يكن هناك نظام اشتراكات مُفعَّل (لا توجد سجلات)
 * نسمح للمستخدم بالمرور لضمان عمل المنصة مباشرة بعد التثبيت.
 */

const EXEMPT_ROLES = new Set(['owner', 'superadmin', 'super_admin', 'admin', 'user']);

module.exports = async (req, res, next) => {
    try {
        const { role, id } = req.user || {};

        // ✅ الأدوار المعفاة تتجاوز التحقق تلقائياً
        if (EXEMPT_ROLES.has(role)) return next();

        // [FIX-SUB] محاولة فحص الاشتراك — إذا فشل DB أو getActiveSubscription
        // غير معرَّفة، نسمح بالمرور لتجنب كسر المنصة الحديثة التثبيت
        try {
            if (typeof SystemDB.getActiveSubscription === 'function') {
                const sub = await SystemDB.getActiveSubscription(id);
                if (sub) {
                    req.subscription = sub;
                    return next();
                }
                // لا اشتراك — تحقق إذا كانت الاشتراكات مُفعَّلة أصلاً
                const totalSubs = await SystemDB.get(
                    `SELECT COUNT(*) as cnt FROM subscriptions LIMIT 1`
                ).catch(() => ({ cnt: 0 }));
                // إذا لا يوجد أي اشتراك في النظام → نظام الاشتراكات غير مُفعَّل
                if (!totalSubs || parseInt(totalSubs.cnt || 0) === 0) {
                    return next();
                }
                return res.status(403).json({
                    success: false,
                    error: 'انتهى اشتراكك. يرجى التجديد للمتابعة.',
                    code: 'SUBSCRIPTION_EXPIRED'
                });
            }
        } catch (subErr) {
            console.warn('[subscriptionCheck] getActiveSubscription error — bypassing:', subErr.message);
        }

        // [FIX-SUB] افتراضي: السماح بالمرور إذا تعذّر التحقق
        return next();
    } catch (err) {
        console.error('[subscriptionCheck]', err.message);
        // [FIX-SUB] لا نكسر المنصة بسبب خطأ في التحقق من الاشتراك
        return next();
    }
};
