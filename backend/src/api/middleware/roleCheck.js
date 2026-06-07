'use strict';

const ROLE_LEVELS = { super_admin:4, admin:3, moderator:2, user:1 };

/**
 * requireRole('admin')  → يُسمح لـ admin أو super_admin فقط
 * requireRole(['admin','moderator']) → يسمح لأي منهم
 */
module.exports = (required) => (req, res, next) => {
    const roles = Array.isArray(required) ? required : [required];
    const userLevel = ROLE_LEVELS[req.user?.role] || 0;
    const minLevel  = Math.min(...roles.map(r => ROLE_LEVELS[r]||99));

    if (userLevel >= minLevel) return next();
    return res.status(403).json({ success:false, error:'ليس لديك صلاحية للوصول لهذه الموارد.' });
};
