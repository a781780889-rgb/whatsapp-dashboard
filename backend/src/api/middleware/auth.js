'use strict';
/**
 * auth.js — JWT Authentication Middleware
 * Phase 5 — FIX-13: Uses JWTService + Blacklist Check
 */
const JWTService = require('../../core/JWTService');

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
            payload = JWTService.verifyAccessToken(token);
        } catch (err) {
            return res.status(401).json({ success: false, error: 'التوكن غير صالح أو منتهي.' });
        }

        // [FIX-13] التحقق من الـ Blacklist في Redis
        const blacklisted = await JWTService.isAccessTokenBlacklisted(token);
        if (blacklisted) {
            return res.status(401).json({ success: false, error: 'التوكن محظور. يرجى تسجيل الدخول مجدداً.' });
        }

        req.user  = payload;
        req.token = token;
        next();

    } catch (err) {
        console.error('[Auth Middleware] Error:', err.message);
        return res.status(500).json({ success: false, error: 'خطأ في التحقق من الهوية.' });
    }
};
