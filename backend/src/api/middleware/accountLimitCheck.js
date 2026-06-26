'use strict';
/**
 * accountLimitCheck.js — التحقق من حد الحسابات قبل إنشاء حساب جديد
 * ─────────────────────────────────────────────────────────────────────
 * يُستخدم فقط على POST /accounts
 */

const SystemDB = require('../../database/SystemDB');
const ADMIN_ROLES = new Set(['super_admin', 'superadmin', 'admin', 'owner']);

module.exports = async (req, res, next) => {
    // الأدمن بلا حد
    if (ADMIN_ROLES.has(req.user?.role)) return next();

    const userId = req.user?.id;

    try {
        const sub = await SystemDB.get(
            `SELECT max_accounts FROM subscriptions
             WHERE user_id=$1 AND status='active'
             AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );

        if (!sub) {
            return res.status(403).json({
                success: false,
                error: 'لا يوجد اشتراك فعّال.',
                code: 'NO_ACTIVE_SUBSCRIPTION',
            });
        }

        // -1 = unlimited
        if (sub.max_accounts === -1) return next();

        const countRow = await SystemDB.get(
            `SELECT COUNT(*) as cnt FROM accounts WHERE user_id=$1`, [userId]
        );
        const used = parseInt(countRow?.cnt || 0, 10);

        if (used >= sub.max_accounts) {
            return res.status(403).json({
                success: false,
                error: `لقد وصلت إلى الحد الأقصى من الحسابات المسموح بها في اشتراكك (${sub.max_accounts} حساب). يرجى التواصل مع المدير للترقية.`,
                code: 'ACCOUNT_LIMIT_REACHED',
                maxAllowed: sub.max_accounts,
                currentCount: used,
            });
        }

        next();
    } catch (err) {
        console.error('[AccountLimitCheck] Error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في التحقق من حد الحسابات.' });
    }
};

