'use strict';
const SystemDB = require('../../database/SystemDB');

/**
 * subscriptionCheck.js
 * يتحقق من أن المستخدم لديه اشتراك نشط.
 * المستويات المعفاة: owner, superadmin, super_admin, admin
 * (الإصلاح: توحيد التحقق من الأدوار لدعم كلا الصيغتين)
 */

const EXEMPT_ROLES = new Set(['owner', 'superadmin', 'super_admin', 'admin']);

module.exports = async (req, res, next) => {
    try {
        const { role, id } = req.user || {};

        // ✅ الأدوار المعفاة تتجاوز التحقق تلقائياً
        if (EXEMPT_ROLES.has(role)) return next();

        const sub = await SystemDB.getActiveSubscription(id);
        if (!sub) {
            return res.status(403).json({
                success: false,
                error: 'انتهى اشتراكك. يرجى التجديد للمتابعة.',
                code: 'SUBSCRIPTION_EXPIRED'
            });
        }

        req.subscription = sub;
        next();
    } catch (err) {
        console.error('[subscriptionCheck]', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في التحقق من الاشتراك.' });
    }
};
