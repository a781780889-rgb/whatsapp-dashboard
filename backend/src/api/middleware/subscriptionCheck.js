'use strict';
const SystemDB = require('../../database/SystemDB');

/**
 * Checks that the authenticated user has an active subscription.
 * Admins and super_admins bypass this check.
 */
module.exports = async (req, res, next) => {
    try {
        const { role, id } = req.user || {};
        if (['super_admin','admin'].includes(role)) return next();

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
    } catch(err) {
        return res.status(500).json({ success:false, error:'خطأ في التحقق من الاشتراك.' });
    }
};
