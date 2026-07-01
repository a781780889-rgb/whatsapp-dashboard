'use strict';
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET         = process.env.JWT_SECRET         || 'a3f7e9d2c8b5f1e6a4d9c2b7f3e8a1d6c9b4f7e2a5d8c1b6f9e3a7d4c2b8f5e1';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'd8c5b2f7e1a4d9c6b3f8e5a2d7c1b4f9e6a3d8c5b2f7e1a4d9c6b3f8e5a2d7c1';

let _redis = null;

const JWTService = {
    setRedis(redis) { _redis = redis; },

    // ── إصدار زوج access + refresh ──────────────────────────────────────────
    issueTokenPair(payload) {
        const family    = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        const accessToken = jwt.sign(
            { ...payload, type: 'access' },
            SECRET,
            { expiresIn: '15m' }
        );

        const refreshToken = jwt.sign(
            { ...payload, family, type: 'refresh' },
            REFRESH_SECRET,
            { expiresIn: '7d' }
        );

        const tokenHash = this.hashToken(refreshToken);
        return { accessToken, refreshToken, family, tokenHash, expiresAt };
    },

    hashToken(token) {
        return crypto.createHash('sha256').update(token).digest('hex');
    },

    // ── Verify ───────────────────────────────────────────────────────────────
    verify(token)               { return jwt.verify(token, SECRET); },
    verifyAccessToken(token)    { return jwt.verify(token, SECRET); },
    verifyRefreshToken(token)   { return jwt.verify(token, REFRESH_SECRET); },

    sign(payload, options = {}) {
        return jwt.sign(payload, SECRET, { expiresIn: '15m', ...options });
    },

    // ── Family tracking via Redis ────────────────────────────────────────────
    async registerFamily(familyId) {
        if (!_redis) return;
        try { await _redis.set(`family:${familyId}`, 'active', 'EX', 7 * 24 * 3600); } catch {}
    },

    async getFamilyStatus(familyId) {
        if (!_redis) return 'active';
        try { return (await _redis.get(`family:${familyId}`)) || 'unknown'; } catch { return 'active'; }
    },

    async compromiseFamily(familyId) {
        if (!_redis) return;
        try { await _redis.set(`family:${familyId}`, 'compromised', 'EX', 7 * 24 * 3600); } catch {}
    },

    async deleteFamily(familyId) {
        if (!_redis) return;
        try { await _redis.del(`family:${familyId}`); } catch {}
    },

    // ── [FIX-AUTH-REUSE] فترة سماح لتسابق rotation الشرعي ────────────────────
    // عند تدوير refresh token، نحفظ "ماذا أصبح التوكن القديم" لفترة قصيرة
    // (ثوانٍ معدودة). إن وصل طلب refresh آخر بنفس التوكن القديم خلال هذه
    // الفترة (تبويب ثانٍ/جهاز آخر استخدم نفس الجلسة تقريباً في نفس اللحظة)،
    // نُعيد له نفس الزوج الجديد بدل معاملته كسرقة واعتبار الجلسة بأكملها
    // مخترقة. بعد انتهاء المهلة، أي إعادة استخدام تُعامل كاختراق حقيقي كالمعتاد.
    async recordRotation(oldTokenHash, newAccessToken, newRefreshToken, graceMs = 10_000) {
        if (!_redis) return;
        try {
            await _redis.set(
                `rot:${oldTokenHash}`,
                JSON.stringify({ accessToken: newAccessToken, refreshToken: newRefreshToken }),
                'PX', graceMs
            );
        } catch {}
    },

    async getRecentRotation(oldTokenHash) {
        if (!_redis) return null;
        try {
            const raw = await _redis.get(`rot:${oldTokenHash}`);
            return raw ? JSON.parse(raw) : null;
        } catch { return null; }
    },

    // ── Blacklist ─────────────────────────────────────────────────────────────
    async blacklistAccessToken(token, payload) {
        if (!_redis) return;
        try {
            const ttl = payload?.exp ? Math.max(0, payload.exp - Math.floor(Date.now() / 1000)) : 900;
            await _redis.set(`bl:${token}`, '1', 'EX', ttl);
        } catch {}
    },

    // aliases لتوافق auth.js
    async isAccessTokenBlacklisted(token) {
        if (!_redis) return false;
        try { return !!(await _redis.get(`bl:${token}`)); } catch { return false; }
    },

    async isBlacklisted(token) {
        return this.isAccessTokenBlacklisted(token);
    },
};

module.exports = JWTService;
