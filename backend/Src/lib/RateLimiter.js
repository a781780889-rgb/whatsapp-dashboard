'use strict';
/**
 * RateLimiter.js — Per-Route Rate Limiting
 * Phase 5 — FIX-15: Rate Limiting per Route
 *
 * الحدود:
 * - POST /auth/login         → 5  req/min  (منع Brute-Force)
 * - POST /auth/refresh       → 10 req/min
 * - POST /send-message       → 100 req/min (WhatsApp sends)
 * - GET  /accounts           → 60  req/min
 * - POST /admin/*            → 30  req/min
 * - Global API               → 500 req/15min
 * - Global Auth              → 30  req/15min (خط دفاع أول)
 */
const rateLimit = require('express-rate-limit');

// ── Key Generator: IP + User ID (إذا موجود) ────────────────────────────────
function keyGenerator(req) {
    const ip     = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const userId = req.user?.id;
    return userId ? `${ip}:${userId}` : ip;
}

function makeLimit({ windowMs, max, message }) {
    return rateLimit({
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders:   false,
        keyGenerator,
        message: { success: false, error: message },
        // لا توقف العمل عند فشل Redis
        skip: (req) => process.env.DISABLE_RATE_LIMIT === 'true',
    });
}

// ── Auth Limiters ─────────────────────────────────────────────────────────────

/** POST /auth/login — 5 محاولات كل دقيقة لكل IP */
const loginLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: 'عدد كبير من محاولات تسجيل الدخول. حاول بعد دقيقة.'
});

/** POST /auth/refresh — 10 تجديد كل دقيقة */
const refreshLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'عدد كبير من طلبات تجديد التوكن. حاول بعد دقيقة.'
});

/** Global Auth Routes — 30 req / 15 min */
const globalAuthLimiter = makeLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'عدد كبير من المحاولات على مسارات المصادقة، حاول بعد 15 دقيقة.'
});

// ── API Limiters ──────────────────────────────────────────────────────────────

/** GET /accounts — 60 req/min */
const listAccountsLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'عدد كبير من طلبات قائمة الحسابات. حاول بعد دقيقة.'
});

/** POST send-message | send | publish — 100 req/min */
const sendMessageLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: 'تجاوزت حد إرسال الرسائل. حاول بعد دقيقة.'
});

/** POST /admin/* — 30 req/min */
const adminLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'عدد كبير من طلبات الإدارة. حاول بعد دقيقة.'
});

/** Global API — 500 req / 15 min */
const globalApiLimiter = makeLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'تجاوزت الحد العام للطلبات. حاول بعد 15 دقيقة.'
});

/** Campaign send — 20 req/min (أبطأ لحماية WhatsApp) */
const campaignSendLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 20,
    message: 'تجاوزت حد بدء الحملات. حاول بعد دقيقة.'
});

module.exports = {
    loginLimiter,
    refreshLimiter,
    globalAuthLimiter,
    listAccountsLimiter,
    sendMessageLimiter,
    adminLimiter,
    globalApiLimiter,
    campaignSendLimiter,
};
