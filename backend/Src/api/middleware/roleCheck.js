'use strict';

/**
 * roleCheck.js
 * مستويات الصلاحيات:
 *   owner        → 5 (المالك الرئيسي - صلاحيات غير محدودة)
 *   superadmin   → 4 (مدير عام كامل الصلاحيات)
 *   super_admin  → 4 (نفس superadmin - للتوافق مع النظام القديم)
 *   admin        → 3 (مدير)
 *   moderator    → 2 (مشرف)
 *   support      → 1.5 (دعم فني)
 *   user         → 1 (مستخدم عادي)
 */

const ROLE_LEVELS = {
    owner:        5,
    superadmin:   4,
    super_admin:  4,
    admin:        3,
    moderator:    2,
    support:      1,
    user:         1
};

/**
 * requireRole('admin')  → يُسمح لـ admin أو أعلى فقط
 * requireRole(['moderator','support']) → يسمح لأي منهم أو أعلى
 */
module.exports = (required) => (req, res, next) => {
    const roles = Array.isArray(required) ? required : [required];
    const userLevel = ROLE_LEVELS[req.user?.role] ?? 0;
    const minLevel  = Math.min(...roles.map(r => ROLE_LEVELS[r] ?? 99));

    if (userLevel >= minLevel) return next();
    return res.status(403).json({
        success: false,
        error: 'ليس لديك صلاحية للوصول إلى هذه الموارد.'
    });
};
