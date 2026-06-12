'use strict';
/**
 * csrf.js — CSRF Protection Middleware
 * Phase 5 — FIX-14: CSRF Protection (Double Submit Cookie Pattern)
 *
 * الآلية:
 * 1. عند كل طلب GET/HEAD → نُولِّد CSRF token ونُرسله كـ Cookie (HttpOnly=false)
 * 2. عند POST/PUT/PATCH/DELETE → نتحقق أن الـ Header يطابق الـ Cookie
 * 3. الـ frontend يقرأ الـ Cookie ويُرسله في X-CSRF-Token Header
 *
 * مسارات مُعفاة:
 * - POST /auth/login   (لا يوجد token بعد)
 * - POST /auth/refresh (يُستخدم refresh token فقط)
 * - /webhook/*         (Meta يُرسل بدون CSRF)
 */
const crypto = require('crypto');

const CSRF_COOKIE  = 'csrf_token';
const CSRF_HEADER  = 'x-csrf-token';
const COOKIE_TTL   = 24 * 60 * 60 * 1000; // 24 ساعة

// مسارات مُعفاة من CSRF
const EXEMPT_PATHS = [
    '/api/v1/auth/login',
    '/api/v1/auth/refresh',
];
const EXEMPT_PREFIX = [
    '/api/v1/webhook/',
];

function generateToken() {
    return crypto.randomBytes(32).toString('hex');
}

function isExempt(path) {
    if (EXEMPT_PATHS.includes(path)) return true;
    if (EXEMPT_PREFIX.some(p => path.startsWith(p))) return true;
    return false;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * csrfMiddleware — يُطبَّق على كل المسارات
 * - على GET: يُولِّد/يُجدِّد الـ token
 * - على الباقي: يتحقق منه
 */
function csrfMiddleware(req, res, next) {
    // مسارات مُعفاة
    if (isExempt(req.path)) return next();

    // الطلبات الآمنة → أصدر أو جدِّد token
    if (SAFE_METHODS.has(req.method)) {
        let token = req.cookies?.[CSRF_COOKIE];
        if (!token) {
            token = generateToken();
            res.cookie(CSRF_COOKIE, token, {
                httpOnly:  false, // مطلوب: الـ frontend يقرأه
                secure:    process.env.NODE_ENV === 'production',
                sameSite:  'strict',
                maxAge:    COOKIE_TTL,
            });
        }
        return next();
    }

    // الطلبات المُعدِّلة → تحقق
    if (process.env.DISABLE_CSRF === 'true') return next(); // للتطوير فقط

    const cookieToken  = req.cookies?.[CSRF_COOKIE];
    const headerToken  = req.headers[CSRF_HEADER];

    if (!cookieToken || !headerToken) {
        return res.status(403).json({
            success: false,
            error:   'طلب غير مُصرَّح به: رمز CSRF مفقود.',
            code:    'CSRF_MISSING'
        });
    }

    // مقارنة ثابتة الوقت (timing-safe)
    try {
        const a = Buffer.from(cookieToken);
        const b = Buffer.from(headerToken);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return res.status(403).json({
                success: false,
                error:   'طلب غير مُصرَّح به: رمز CSRF غير صالح.',
                code:    'CSRF_INVALID'
            });
        }
    } catch {
        return res.status(403).json({
            success: false,
            error:   'طلب غير مُصرَّح به.',
            code:    'CSRF_ERROR'
        });
    }

    next();
}

/**
 * csrfTokenRoute — GET /api/v1/auth/csrf-token
 * يُصدر token جديداً ويُرسله بشكل صريح
 */
function csrfTokenRoute(req, res) {
    const token = generateToken();
    res.cookie(CSRF_COOKIE, token, {
        httpOnly:  false,
        secure:    process.env.NODE_ENV === 'production',
        sameSite:  'strict',
        maxAge:    COOKIE_TTL,
    });
    res.json({ success: true, csrfToken: token });
}

module.exports = { csrfMiddleware, csrfTokenRoute };
