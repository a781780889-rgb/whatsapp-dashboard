'use strict';
/**
 * JWTService.js — Enterprise JWT Service
 * Phase 5 — FIX-13: JWT Rotation with Family Tracking
 *
 * الميزات:
 * 1. Family Tracking: كل مجموعة refresh tokens تنتمي لـ "family" واحد
 * 2. Token Theft Detection: إذا استُخدم token مُبطَل من family نشط → نُبطل الـ family كله
 * 3. Revocation List في Redis: Access tokens المُبطَلة تُخزَّن مع TTL
 * 4. Rotation Enforcement: كل استخدام للـ refresh token يُولِّد واحداً جديداً
 */
const jwt    = require('jsonwebtoken');
const crypto = require('crypto');

// ── Secrets ───────────────────────────────────────────────────────────────────
function getAccessSecret() {
    const s = process.env.JWT_SECRET;
    if (!s) throw new Error('[JWTService] JWT_SECRET is not set.');
    return s;
}

function getRefreshSecret() {
    return process.env.JWT_REFRESH_SECRET || (process.env.JWT_SECRET + '_refresh');
}

// ── Durations ─────────────────────────────────────────────────────────────────
const ACCESS_TTL_STR  = process.env.JWT_EXPIRES_IN        || '15m';
const REFRESH_TTL_STR = process.env.REFRESH_TOKEN_EXPIRES || '7d';
const REFRESH_TTL_MS  = 7 * 24 * 60 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

function generateFamily() {
    return crypto.randomBytes(16).toString('hex');
}

// ── Redis Key Builders ────────────────────────────────────────────────────────
const KEY_BLACKLIST  = (hash)   => `jwt_blacklist:${hash}`;
const KEY_FAMILY     = (family) => `jwt_family:${family}`;
const FAMILY_TTL_SEC = REFRESH_TTL_MS / 1000;

class JWTService {
    constructor() {
        this._redis = null;
    }

    /**
     * يُحقن عند تهيئة التطبيق (اختياري — يعمل بدون Redis لكن بدون blacklist)
     */
    setRedis(redisClient) {
        this._redis = redisClient;
    }

    _redis_safe() {
        return this._redis || null;
    }

    // ── Sign ──────────────────────────────────────────────────────────────────

    signAccessToken(payload) {
        return jwt.sign(payload, getAccessSecret(), { expiresIn: ACCESS_TTL_STR });
    }

    signRefreshToken(payload) {
        return jwt.sign(payload, getRefreshSecret(), { expiresIn: REFRESH_TTL_STR });
    }

    /**
     * ينشئ زوجاً (access + refresh) مع family جديد
     * @returns {{ accessToken, refreshToken, family, tokenHash, expiresAt }}
     */
    issueTokenPair(payload) {
        const family       = generateFamily();
        const accessToken  = this.signAccessToken({ ...payload, family });
        const refreshToken = this.signRefreshToken({ ...payload, family });
        const tokenHash    = hashToken(refreshToken);
        const expiresAt    = new Date(Date.now() + REFRESH_TTL_MS);
        return { accessToken, refreshToken, family, tokenHash, expiresAt };
    }

    // ── Verify ────────────────────────────────────────────────────────────────

    verifyAccessToken(token) {
        return jwt.verify(token, getAccessSecret());
    }

    verifyRefreshToken(token) {
        return jwt.verify(token, getRefreshSecret());
    }

    // ── Blacklist (Access Tokens) ─────────────────────────────────────────────

    /**
     * يُضيف access token للـ blacklist في Redis حتى انتهاء صلاحيته
     */
    async blacklistAccessToken(token, payload) {
        const redis = this._redis_safe();
        if (!redis) return;
        try {
            const ttl = (payload?.exp || 0) - Math.floor(Date.now() / 1000);
            if (ttl > 0) {
                await redis.set(KEY_BLACKLIST(token), '1', 'EX', ttl);
            }
        } catch (err) {
            console.warn('[JWTService] blacklistAccessToken failed (non-critical):', err.message);
        }
    }

    /**
     * يتحقق إذا كان الـ access token محظوراً
     */
    async isAccessTokenBlacklisted(token) {
        const redis = this._redis_safe();
        if (!redis) return false;
        try {
            const val = await redis.get(KEY_BLACKLIST(token));
            return val === '1';
        } catch {
            return false; // Redis unavailable → allow
        }
    }

    // ── Family Tracking (Refresh Token Theft Detection) ───────────────────────

    /**
     * يُسجِّل الـ family في Redis عند إصدار أول refresh token
     * family_key → 'active' | 'compromised'
     */
    async registerFamily(family) {
        const redis = this._redis_safe();
        if (!redis) return;
        try {
            await redis.set(KEY_FAMILY(family), 'active', 'EX', FAMILY_TTL_SEC);
        } catch (err) {
            console.warn('[JWTService] registerFamily failed:', err.message);
        }
    }

    /**
     * يتحقق من حالة الـ family:
     * - 'active'      → مقبول
     * - 'compromised' → مسروق، ارفض واحذف
     * - null          → غير موجود (منتهي أو مُبطَل من DB)
     */
    async getFamilyStatus(family) {
        const redis = this._redis_safe();
        if (!redis) return 'active'; // بدون Redis → لا تحقق
        try {
            return await redis.get(KEY_FAMILY(family));
        } catch {
            return 'active';
        }
    }

    /**
     * يُعلِّم الـ family بأنه مخترق عند اكتشاف إعادة استخدام
     */
    async compromiseFamily(family) {
        const redis = this._redis_safe();
        if (!redis) return;
        try {
            await redis.set(KEY_FAMILY(family), 'compromised', 'EX', FAMILY_TTL_SEC);
        } catch (err) {
            console.warn('[JWTService] compromiseFamily failed:', err.message);
        }
    }

    /**
     * يحذف الـ family (عند logout أو revoke كامل)
     */
    async deleteFamily(family) {
        const redis = this._redis_safe();
        if (!redis) return;
        try {
            await redis.del(KEY_FAMILY(family));
        } catch {}
    }

    // ── Utilities ─────────────────────────────────────────────────────────────

    hashToken(token) { return hashToken(token); }
    generateFamily()  { return generateFamily(); }
    getRefreshTTL_MS() { return REFRESH_TTL_MS; }
}

module.exports = new JWTService();
