'use strict';
/**
 * RateLimiter.js — Per-Route Rate Limiting
 * Phase 5 — FIX-15: Rate Limiting per Route
 * FIX-IPv6: استخدام ipKeyGenerator لتفادي خطأ ERR_ERL_KEY_GEN_IPV6
 */
const rateLimit = require('express-rate-limit');

// ── Key Generator: IP + User ID ────────────────────────────────────────────
// express-rate-limit v7+ يشترط استخدام ipKeyGenerator عند بناء مفتاح من req.ip
function keyGenerator(req) {
    // استخدم الدالة المدمجة لاستخراج IP بشكل آمن (تدعم IPv4 و IPv6)
    const ip = rateLimit.ipKeyGenerator(req);
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
        skip: (req) => process.env.DISABLE_RATE_LIMIT === 'true',
    });
}

// ── Auth Limiters ──────────────────────────────────────────────────────────

const loginLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 5,
    message: 'عدد كبير من محاولات تسجيل الدخول. حاول بعد دقيقة.'
});

const refreshLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 10,
    message: 'عدد كبير من طلبات تجديد التوكن. حاول بعد دقيقة.'
});

const globalAuthLimiter = makeLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'عدد كبير من المحاولات على مسارات المصادقة، حاول بعد 15 دقيقة.'
});

// ── API Limiters ───────────────────────────────────────────────────────────

const listAccountsLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 60,
    message: 'عدد كبير من طلبات قائمة الحسابات. حاول بعد دقيقة.'
});

const sendMessageLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 100,
    message: 'تجاوزت حد إرسال الرسائل. حاول بعد دقيقة.'
});

const adminLimiter = makeLimit({
    windowMs: 60 * 1000,
    max: 30,
    message: 'عدد كبير من طلبات الإدارة. حاول بعد دقيقة.'
});

const globalApiLimiter = makeLimit({
    windowMs: 15 * 60 * 1000,
    max: 500,
    message: 'تجاوزت الحد العام للطلبات. حاول بعد 15 دقيقة.'
});

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
