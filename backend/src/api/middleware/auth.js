'use strict';
/**
 * auth.js — بدون تسجيل دخول
 * جميع الطلبات تمر تلقائياً كـ superadmin
 */

module.exports = async (req, res, next) => {
    // تعيين المستخدم تلقائياً كـ superadmin بدون أي تحقق
    req.user = {
        id: 'auto-admin',
        username: 'admin',
        role: 'superadmin',
        full_name: 'Admin'
    };
    req.token = 'no-auth';
    next();
};
