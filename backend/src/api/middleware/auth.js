'use strict';
/**
 * auth.js Middleware — JWT Verification
 * Section 15.1 + 13.4 من وثيقة التحليل:
 *
 * إصلاحات أمنية حرجة:
 * 1. إزالة JWT_SECRET الافتراضي من الكود تماماً (الخطر: أي شخص يعرف المفتاح يولّد Tokens صالحة).
 * 2. إضافة Redis Blacklist للتحقق من الـ Tokens المُلغاة عند تسجيل الخروج.
 * 3. دعم Access Token قصير الصلاحية (15 دقيقة) + Refresh Token (7 أيام).
 */
const jwt    = require('jsonwebtoken');
const { getRedis } = require('../../../src/lib/redis');

function getSecret() {
    const secret = process.env.JWT_SECRET;
    // Section 15.1 + 16.3 قرار #2: إزالة Fallback بالكامل — Runtime Error إذا لم يُعيَّن.
    if (!secret) {
        throw new Error('[SECURITY CRITICAL] JWT_SECRET environment variable is not set. Application cannot start without it.');
    }
    return secret;
}

module.exports = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer '))
        return res.status(401).json({ success: false, error: 'غير مصرح: التوكن مطلوب.' });

    const token = authHeader.split(' ')[1];

    try {
        const payload = jwt.verify(token, getSecret());

        // Section 15.1: Redis JWT Blacklist — التحقق من الـ Tokens المُلغاة
        try {
            const redis = getRedis();
            const isBlacklisted = await redis.get(`jwt_blacklist:${token}`);
            if (isBlacklisted) {
                return res.status(401).json({ success: false, error: 'انتهت صلاحية الجلسة. سجل دخولك مجدداً.' });
            }
        } catch (redisErr) {
            // Redis unavailable — log warning but allow request (fail-open for availability)
            console.warn('[Auth] Redis blacklist check failed:', redisErr.message);
        }

        req.user  = payload;
        req.token = token; // Store for logout use
        next();
    } catch(err) {
        if (err.name === 'TokenExpiredError')
            return res.status(401).json({ success: false, error: 'انتهت صلاحية الجلسة. سجل دخولك مجدداً.' });
        return res.status(403).json({ success: false, error: 'توكن غير صالح.' });
    }
};
