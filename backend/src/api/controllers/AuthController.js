'use strict';
/**
 * AuthController — Enterprise Authentication
 * Section 6.2 + 13.4 + 15.1 + 15.2 من وثيقة التحليل:
 *
 * الميزات المُضافة:
 * 1. Access Token قصير (15 دقيقة) + Refresh Token طويل (7 أيام).
 * 2. Redis JWT Blacklist عند تسجيل الخروج.
 * 3. MFA / TOTP للحسابات الإدارية (speakeasy).
 * 4. إزالة JWT_SECRET الافتراضي بالكامل.
 */
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');
const speakeasy = require('speakeasy');
const QRCode   = require('qrcode');
const SystemDB = require('../../database/SystemDB');
const { getRedis } = require('../../lib/redis');

// ── Token Durations ──────────────────────────────────────────────────────────
const ACCESS_TOKEN_EXPIRES  = process.env.JWT_EXPIRES_IN     || '15m';
const REFRESH_TOKEN_EXPIRES = process.env.REFRESH_TOKEN_EXPIRES || '7d';
const REFRESH_TOKEN_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days in ms

function getSecret() {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('[SECURITY] JWT_SECRET not set in environment.');
    return secret;
}

function getRefreshSecret() {
    const secret = process.env.JWT_REFRESH_SECRET || (process.env.JWT_SECRET + '_refresh');
    return secret;
}

function signAccessToken(payload) {
    return jwt.sign(payload, getSecret(), { expiresIn: ACCESS_TOKEN_EXPIRES });
}

function signRefreshToken(payload) {
    return jwt.sign(payload, getRefreshSecret(), { expiresIn: REFRESH_TOKEN_EXPIRES });
}

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

class AuthController {

    _ip(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || 'unknown';
    }

    // ── POST /api/v1/auth/login ──────────────────────────────────────────────
    async login(req, res) {
        const { username, password, mfaCode } = req.body || {};
        const ip = this._ip(req);

        if (!username || !password)
            return res.status(400).json({ success: false, error: 'اسم المستخدم وكلمة المرور مطلوبان.' });

        try {
            // ── Brute-Force Check ────────────────────────────────────────────
            const block = await SystemDB.isBlocked(username);
            if (block) {
                const until = new Date(block.blocked_until);
                const mins  = Math.ceil((until - Date.now()) / 60000);
                return res.status(429).json({
                    success: false,
                    error: `تم حظر الحساب مؤقتاً لعدة محاولات خاطئة. حاول بعد ${mins} دقيقة.`,
                    lockedUntil: block.blocked_until
                });
            }

            // ── Find User ────────────────────────────────────────────────────
            const user = await SystemDB.get(
                `SELECT * FROM users WHERE username = $1 AND status != 'suspended'`, [username]);

            if (!user) {
                await SystemDB.recordAttempt(username, ip, false);
                await SystemDB.log(null, username, 'LOGIN_FAILED', `User not found. IP: ${ip}`, ip);
                return res.status(401).json({ success: false, error: 'بيانات الاعتماد غير صحيحة.' });
            }

            // ── Password Check ───────────────────────────────────────────────
            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                await SystemDB.recordAttempt(username, ip, false);
                await SystemDB.log(user.id, username, 'LOGIN_FAILED', `Wrong password. IP: ${ip}`, ip);
                return res.status(401).json({ success: false, error: 'بيانات الاعتماد غير صحيحة.' });
            }

            // ── MFA Check (Section 6.2 — ضروري فوراً للحسابات الإدارية) ──────
            if (user.mfa_enabled && user.mfa_secret) {
                if (!mfaCode) {
                    return res.status(200).json({ success: false, requiresMFA: true, error: 'مطلوب رمز المصادقة الثنائية.' });
                }
                const verified = speakeasy.totp.verify({
                    secret: user.mfa_secret,
                    encoding: 'base32',
                    token: mfaCode,
                    window: 1,
                });
                if (!verified) {
                    await SystemDB.recordAttempt(username, ip, false);
                    await SystemDB.log(user.id, username, 'MFA_FAILED', `IP: ${ip}`, ip);
                    return res.status(401).json({ success: false, error: 'رمز المصادقة الثنائية غير صحيح.' });
                }
            }

            // ── Subscription Check ───────────────────────────────────────────
            let subscriptionStatus = 'active';
            let daysRemaining = -1;
            let planType = 'lifetime';

            if (!['super_admin','admin'].includes(user.role)) {
                const sub = await SystemDB.getActiveSubscription(user.id);
                if (!sub) {
                    subscriptionStatus = 'expired';
                } else {
                    daysRemaining = await SystemDB.getDaysRemaining(sub);
                    planType = sub.plan_type;
                    if (daysRemaining === 0 && planType !== 'lifetime') subscriptionStatus = 'expired';
                }
                if (subscriptionStatus === 'expired') {
                    await SystemDB.recordAttempt(username, ip, false);
                    await SystemDB.log(user.id, username, 'LOGIN_BLOCKED', 'Subscription expired', ip);
                    return res.status(403).json({ success: false, error: 'انتهى اشتراكك. يرجى التجديد للمتابعة.' });
                }
            }

            // ── Record Success & Update last_login ───────────────────────────
            await SystemDB.recordAttempt(username, ip, true);
            await SystemDB.run(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);
            await SystemDB.log(user.id, username, 'LOGIN_SUCCESS', `IP: ${ip}`, ip);

            // ── Issue Access Token (15min) + Refresh Token (7 days) ──────────
            const tokenPayload = { id: user.id, username: user.username, role: user.role };
            const accessToken  = signAccessToken(tokenPayload);
            const refreshToken = signRefreshToken(tokenPayload);

            // Store refresh token hash in DB
            const tokenHash  = hashToken(refreshToken);
            const expiresAt  = new Date(Date.now() + REFRESH_TOKEN_MS);
            const userAgent  = req.headers['user-agent'] || '';
            await SystemDB.saveRefreshToken(user.id, tokenHash, ip, userAgent, expiresAt);

            return res.json({
                success: true,
                accessToken,
                refreshToken,
                expiresIn: ACCESS_TOKEN_EXPIRES,
                user: {
                    id: user.id,
                    username: user.username,
                    fullName: user.full_name,
                    role: user.role,
                    mfaEnabled: !!user.mfa_enabled,
                    subscriptionStatus,
                    daysRemaining,
                    planType
                }
            });

        } catch (err) {
            console.error('[Auth] Login error:', err);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم.' });
        }
    }

    // ── POST /api/v1/auth/refresh ────────────────────────────────────────────
    // Section 13.4: Refresh Token Pattern
    async refresh(req, res) {
        const { refreshToken } = req.body || {};
        if (!refreshToken)
            return res.status(401).json({ success: false, error: 'Refresh Token مطلوب.' });

        try {
            const payload = jwt.verify(refreshToken, getRefreshSecret());
            const tokenHash = hashToken(refreshToken);
            const stored = await SystemDB.findRefreshToken(tokenHash);

            if (!stored)
                return res.status(401).json({ success: false, error: 'Refresh Token غير صالح أو منتهي.' });

            // Rotate refresh token (one-time use)
            await SystemDB.revokeRefreshToken(tokenHash);

            const user = await SystemDB.get(`SELECT id, username, role FROM users WHERE id = $1`, [payload.id]);
            if (!user) return res.status(401).json({ success: false, error: 'المستخدم غير موجود.' });

            const newTokenPayload = { id: user.id, username: user.username, role: user.role };
            const newAccessToken  = signAccessToken(newTokenPayload);
            const newRefreshToken = signRefreshToken(newTokenPayload);

            const newHash    = hashToken(newRefreshToken);
            const expiresAt  = new Date(Date.now() + REFRESH_TOKEN_MS);
            const ip         = this._ip(req);
            const userAgent  = req.headers['user-agent'] || '';
            await SystemDB.saveRefreshToken(user.id, newHash, ip, userAgent, expiresAt);

            return res.json({ success: true, accessToken: newAccessToken, refreshToken: newRefreshToken });
        } catch (err) {
            return res.status(401).json({ success: false, error: 'Refresh Token غير صالح.' });
        }
    }

    // ── GET /api/v1/auth/verify ──────────────────────────────────────────────
    async verify(req, res) {
        const user = await SystemDB.get(
            `SELECT id,username,full_name,role,status,last_login,mfa_enabled FROM users WHERE id = $1`,
            [req.user.id]
        ).catch(() => null);
        if (!user) return res.status(401).json({ success: false, error: 'User not found.' });

        const sub = await SystemDB.getActiveSubscription(user.id);
        const daysRemaining = await SystemDB.getDaysRemaining(sub);

        res.json({
            success: true,
            user: {
                ...user,
                subscriptionStatus: sub ? 'active' : 'expired',
                daysRemaining,
                planType: sub?.plan_type
            }
        });
    }

    // ── POST /api/v1/auth/logout ─────────────────────────────────────────────
    async logout(req, res) {
        const ip = this._ip(req);

        // Section 15.1: Blacklist the current Access Token in Redis
        try {
            const redis   = getRedis();
            const token   = req.token; // injected by auth middleware
            const payload = req.user;
            if (token && payload?.exp) {
                const ttl = payload.exp - Math.floor(Date.now() / 1000);
                if (ttl > 0) {
                    await redis.set(`jwt_blacklist:${token}`, '1', 'EX', ttl);
                }
            }
        } catch (err) {
            console.warn('[Auth] Logout blacklist failed:', err.message);
        }

        // Revoke refresh token if provided
        const { refreshToken } = req.body || {};
        if (refreshToken) {
            await SystemDB.revokeRefreshToken(hashToken(refreshToken)).catch(() => {});
        }

        await SystemDB.log(req.user?.id, req.user?.username, 'LOGOUT', '', ip);
        res.json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
    }

    // ── POST /api/v1/auth/change-password ────────────────────────────────────
    async changePassword(req, res) {
        const { oldPassword, newPassword } = req.body || {};
        if (!oldPassword || !newPassword || newPassword.length < 8)
            return res.status(400).json({ success: false, error: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.' });

        const user = await SystemDB.get(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) return res.status(401).json({ success: false, error: 'كلمة المرور الحالية غير صحيحة.' });

        const hash = await bcrypt.hash(newPassword, 12);
        await SystemDB.run(`UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`, [hash, user.id]);

        // Revoke all refresh tokens on password change
        await SystemDB.revokeAllUserTokens(user.id);

        await SystemDB.log(user.id, user.username, 'CHANGE_PASSWORD', '', this._ip(req));
        res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح. يرجى تسجيل الدخول من جديد.' });
    }

    // ── POST /api/v1/auth/mfa/setup ─────────────────────────────────────────
    // Section 6.2: MFA ضروري فوراً للحسابات الإدارية — speakeasy TOTP
    async setupMFA(req, res) {
        try {
            const user = await SystemDB.get(`SELECT id, username, mfa_enabled FROM users WHERE id = $1`, [req.user.id]);
            if (user.mfa_enabled)
                return res.status(400).json({ success: false, error: 'المصادقة الثنائية مُفعَّلة بالفعل.' });

            const secret = speakeasy.generateSecret({
                name: `WhatsApp SaaS (${user.username})`,
                length: 20,
            });

            // Temporarily store secret in DB (not yet active)
            await SystemDB.run(
                `UPDATE users SET mfa_secret = $1 WHERE id = $2`,
                [secret.base32, user.id]
            );

            const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

            return res.json({
                success: true,
                secret: secret.base32,
                qrCode: qrCodeUrl,
                message: 'امسح رمز QR بتطبيق Google Authenticator ثم أرسل الرمز للتأكيد.'
            });
        } catch (err) {
            console.error('[Auth] MFA setup error:', err);
            return res.status(500).json({ success: false, error: 'خطأ في إعداد المصادقة الثنائية.' });
        }
    }

    // ── POST /api/v1/auth/mfa/verify ────────────────────────────────────────
    async verifyMFA(req, res) {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ success: false, error: 'رمز MFA مطلوب.' });

        try {
            const user = await SystemDB.get(`SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1`, [req.user.id]);
            if (!user?.mfa_secret)
                return res.status(400).json({ success: false, error: 'لم يتم إعداد MFA بعد.' });

            const verified = speakeasy.totp.verify({
                secret: user.mfa_secret,
                encoding: 'base32',
                token: code,
                window: 1,
            });

            if (!verified)
                return res.status(400).json({ success: false, error: 'الرمز غير صحيح.' });

            // Activate MFA
            await SystemDB.run(`UPDATE users SET mfa_enabled = TRUE WHERE id = $1`, [req.user.id]);
            await SystemDB.log(req.user.id, req.user.username, 'MFA_ENABLED', '', this._ip(req));

            return res.json({ success: true, message: 'تم تفعيل المصادقة الثنائية بنجاح.' });
        } catch (err) {
            console.error('[Auth] MFA verify error:', err);
            return res.status(500).json({ success: false, error: 'خطأ في التحقق من MFA.' });
        }
    }

    // ── DELETE /api/v1/auth/mfa ──────────────────────────────────────────────
    async disableMFA(req, res) {
        const { code, password } = req.body || {};
        if (!code || !password)
            return res.status(400).json({ success: false, error: 'كلمة المرور ورمز MFA مطلوبان.' });

        try {
            const user = await SystemDB.get(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
            const passMatch = await bcrypt.compare(password, user.password);
            if (!passMatch) return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });

            const verified = speakeasy.totp.verify({
                secret: user.mfa_secret,
                encoding: 'base32',
                token: code,
                window: 1,
            });
            if (!verified) return res.status(400).json({ success: false, error: 'رمز MFA غير صحيح.' });

            await SystemDB.run(
                `UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL WHERE id = $1`,
                [req.user.id]
            );
            await SystemDB.log(req.user.id, req.user.username, 'MFA_DISABLED', '', this._ip(req));

            return res.json({ success: true, message: 'تم إلغاء تفعيل المصادقة الثنائية.' });
        } catch (err) {
            console.error('[Auth] MFA disable error:', err);
            return res.status(500).json({ success: false, error: 'خطأ في إلغاء MFA.' });
        }
    }
}

module.exports = new AuthController();
