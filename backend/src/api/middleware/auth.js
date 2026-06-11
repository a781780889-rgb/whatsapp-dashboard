'use strict';
/**
 * auth.js — JWT Authentication Middleware
 * يتحقق من Bearer Token في كل طلب محمي
 */
const jwt = require('jsonwebtoken');

function getSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('JWT_SECRET is not set');
    return s;
}

module.exports = async (req, res, next) => {
    try {
        // استخراج التوكن من الـ Header
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

        if (!token) {
            return res.status(401).json({ success: false, error: 'لا يوجد توكن. يرجى تسجيل الدخول.' });
        }

        // التحقق من صحة التوكن
        let payload;
        try {
            payload = jwt.verify(token, getSecret());
        } catch (err) {
            return res.status(401).json({ success: false, error: 'التوكن غير صالح أو منتهي.' });
        }

        // التحقق من الـ Blacklist في Redis (اختياري — لا يوقف العمل إذا فشل)
        try {
            const { getRedis } = require('../lib/redis');
            const redis = getRedis();
            const blacklisted = await redis.get(`jwt_blacklist:${token}`);
            if (blacklisted) {
                return res.status(401).json({ success: false, error: 'التوكن محظور. يرجى تسجيل الدخول مجدداً.' });
            }
        } catch {
            // Redis غير متاح — نكمل بدون blacklist check
        }

        req.user  = payload;
        req.token = token;
        next();

    } catch (err) {
        console.error('[Auth Middleware] Error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في التحقق من الهوية.' });
    }
};
