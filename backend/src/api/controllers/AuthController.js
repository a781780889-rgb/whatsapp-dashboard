'use strict';
/**
 * AuthController — Enterprise Authentication
 * Phase 5 — FIX-13: JWT Rotation + Family Tracking + Token Theft Detection
 *
 * ما الجديد:
 * 1. يستخدم JWTService بدلاً من jwt مباشرة
 * 2. Family tracking: كل زوج access/refresh ينتمي لـ family
 * 3. Token Theft Detection: إعادة استخدام refresh token مُبطَل → نُبطِل الـ family كله
 * 4. EncryptionService: تشفير البيانات الحساسة في DB
 */
const bcrypt    = require('bcryptjs');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const SystemDB  = require('../../database/SystemDB');
const JWTService       = require('../../core/JWTService');
const EncryptionService = require('../../core/EncryptionService');

// ── Role Normalization ────────────────────────────────────────────────────────
function normalizeRole(role) {
    if (role === 'superadmin') return 'super_admin';
    if (role === 'owner')      return 'super_admin';
    return role;
}

class AuthController {

    _ip(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
            || req.socket?.remoteAddress
            || 'unknown';
    }

    // ── POST /api/v1/auth/login ───────────────────────────────────────────────
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

            // ── Account Lockout ───────────────────────────────────────────────
            if (user.locked_until && new Date(user.locked_until) > new Date()) {
                const minsLeft = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
                return res.status(429).json({ success: false, error: `الحساب مقفل مؤقتاً. حاول بعد ${minsLeft} دقيقة.` });
            }

            // ── Password Check ───────────────────────────────────────────────
            const match = await bcrypt.compare(password, user.password);
            if (!match) {
                await SystemDB.recordAttempt(username, ip, false);
                const newCount    = (user.failed_login_count || 0) + 1;
                const lockedUntil = newCount >= 5 ? new Date(Date.now() + 15 * 60000).toISOString() : null;
                await SystemDB.run(
                    `UPDATE users SET failed_login_count=$1, last_failed_login=NOW(), locked_until=$2 WHERE id=$3`,
                    [newCount, lockedUntil, user.id]
                ).catch(() => {});
                await SystemDB.log(user.id, username, 'LOGIN_FAILED', `Wrong password (attempt ${newCount}). IP: ${ip}`, ip);
                return res.status(401).json({ success: false, error: 'بيانات الاعتماد غير صحيحة.' });
            }
            // إعادة تعيين عداد الفشل
            await SystemDB.run(`UPDATE users SET failed_login_count=0, locked_until=NULL WHERE id=$1`, [user.id]).catch(() => {});

            // ── MFA Check ────────────────────────────────────────────────────
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

            // ── Subscription Check (non-admin users only) ─────────────────────
            const nonAdminRoles = new Set(['user', 'moderator', 'support']);
            if (nonAdminRoles.has(normalizeRole(user.role))) {
                const sub = await SystemDB.get(
                    `SELECT id, status, expires_at FROM subscriptions
                     WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
                    [user.id]
                ).catch(() => null);

                if (!sub || sub.status !== 'active') {
                    await SystemDB.recordAttempt(username, ip, false);
                    return res.status(403).json({
                        success: false,
                        error: 'اشتراكك غير فعّال. يرجى التواصل مع المدير.',
                        code: 'SUBSCRIPTION_INACTIVE',
                    });
                }

                if (sub.expires_at && new Date(sub.expires_at) <= new Date()) {
                    await SystemDB.recordAttempt(username, ip, false);
                    return res.status(403).json({
                        success: false,
                        error: 'انتهت مدة اشتراكك. يرجى التواصل مع المدير لتجديد الاشتراك.',
                        code: 'SUBSCRIPTION_EXPIRED',
                        expiresAt: sub.expires_at,
                    });
                }
            }

            // ── Record Success ───────────────────────────────────────────────
            await SystemDB.recordAttempt(username, ip, true);
            await SystemDB.run(`UPDATE users SET last_login = NOW() WHERE id = $1`, [user.id]);
            await SystemDB.log(user.id, username, 'LOGIN_SUCCESS', `IP: ${ip}`, ip);

            // ── [FIX-13] Issue Token Pair with Family ─────────────────────────
            const normalizedRole = normalizeRole(user.role);
            const tokenPayload   = { id: user.id, username: user.username, role: normalizedRole };

            const { accessToken, refreshToken, family, tokenHash, expiresAt }
                = JWTService.issueTokenPair(tokenPayload);

            // حفظ hash الـ refresh token في DB (مع family)
            const userAgent = req.headers['user-agent'] || '';
            await SystemDB.saveRefreshToken(user.id, tokenHash, ip, userAgent, expiresAt, family);

            // تسجيل الـ family في Redis
            await JWTService.registerFamily(family);

            return res.json({
                success: true,
                accessToken,
                refreshToken,
                expiresIn: process.env.JWT_EXPIRES_IN || '15m',
                user: {
                    id: user.id,
                    username: user.username,
                    fullName: user.full_name,
                    role: normalizedRole,
                    mfaEnabled: !!user.mfa_enabled,
                }
            });

        } catch (err) {
            console.error('[Auth] Login error:', err);
            return res.status(500).json({ success: false, error: 'خطأ داخلي في الخادم.' });
        }
    }

    // ── POST /api/v1/auth/refresh ─────────────────────────────────────────────
    // FIX-13: Rotation + Family Tracking + Theft Detection
    async refresh(req, res) {
        const { refreshToken } = req.body || {};
        if (!refreshToken)
            return res.status(401).json({ success: false, error: 'Refresh Token مطلوب.' });

        try {
            // تحقق من صحة التوكن cryptographically
            let payload;
            try {
                payload = JWTService.verifyRefreshToken(refreshToken);
            } catch {
                return res.status(401).json({ success: false, error: 'Refresh Token غير صالح أو منتهي.' });
            }

            const tokenHash = JWTService.hashToken(refreshToken);
            const family    = payload.family;

            // ── [FIX-13] Token Theft Detection ───────────────────────────────
            if (family) {
                const familyStatus = await JWTService.getFamilyStatus(family);

                if (familyStatus === 'compromised') {
                    // Family مخترق → ارفض فوراً وأبطل كل tokens في DB
                    await SystemDB.revokeAllUserTokensByFamily(family).catch(() => {});
                    console.warn(`[Auth] COMPROMISED family detected for user ${payload.id}. All tokens revoked.`);
                    return res.status(401).json({
                        success: false,
                        error:   'تم اكتشاف استخدام مشبوه. يرجى تسجيل الدخول من جديد.',
                        code:    'TOKEN_FAMILY_COMPROMISED'
                    });
                }
            }

            // ── تحقق من DB ────────────────────────────────────────────────────
            const stored = await SystemDB.findRefreshToken(tokenHash);

            if (!stored) {
                // التوكن مُبطَل في DB لكنه لا يزال صالح cryptographically
                // → إعادة استخدام بعد rotation → سرقة محتملة!
                if (family) {
                    await JWTService.compromiseFamily(family);
                    await SystemDB.revokeAllUserTokensByFamily(family).catch(() => {});
                    console.warn(`[Auth] REUSE DETECTED — family ${family} for user ${payload.id} marked compromised.`);
                }
                return res.status(401).json({
                    success: false,
                    error:   'Refresh Token غير صالح. يُرجى تسجيل الدخول من جديد.',
                    code:    'TOKEN_REUSE_DETECTED'
                });
            }

            // ── Rotate: أبطل القديم ──────────────────────────────────────────
            await SystemDB.revokeRefreshToken(tokenHash);

            // ── أصدر زوجاً جديداً بنفس الـ family ───────────────────────────
            const user = await SystemDB.get(`SELECT id, username, role FROM users WHERE id = $1`, [payload.id]);
            if (!user) return res.status(401).json({ success: false, error: 'المستخدم غير موجود.' });

            const normalizedRole  = normalizeRole(user.role);
            const newTokenPayload = { id: user.id, username: user.username, role: normalizedRole };

            const {
                accessToken:  newAccessToken,
                refreshToken: newRefreshToken,
                family:       newFamily,
                tokenHash:    newHash,
                expiresAt:    newExpiresAt
            } = JWTService.issueTokenPair(newTokenPayload);

            const ip        = this._ip(req);
            const userAgent = req.headers['user-agent'] || '';
            await SystemDB.saveRefreshToken(user.id, newHash, ip, userAgent, newExpiresAt, newFamily);

            // تحديث الـ family في Redis
            if (family) await JWTService.deleteFamily(family);
            await JWTService.registerFamily(newFamily);

            return res.json({
                success:      true,
                accessToken:  newAccessToken,
                refreshToken: newRefreshToken
            });

        } catch (err) {
            console.error('[Auth] Refresh error:', err);
            return res.status(401).json({ success: false, error: 'Refresh Token غير صالح.' });
        }
    }

    // ── GET /api/v1/auth/verify ───────────────────────────────────────────────
    async verify(req, res) {
        const user = await SystemDB.get(
            `SELECT id,username,full_name,role,status,last_login,mfa_enabled FROM users WHERE id = $1`,
            [req.user.id]
        ).catch(() => null);
        if (!user) return res.status(401).json({ success: false, error: 'User not found.' });

        res.json({
            success: true,
            user: {
                ...user,
                role: normalizeRole(user.role),
            }
        });
    }

    // ── POST /api/v1/auth/logout ──────────────────────────────────────────────
    async logout(req, res) {
        const ip = this._ip(req);

        // [FIX-13] Blacklist Access Token في Redis
        try {
            const token   = req.token;
            const payload = req.user;
            await JWTService.blacklistAccessToken(token, payload);

            // حذف الـ family من Redis
            if (payload?.family) {
                await JWTService.deleteFamily(payload.family);
            }
        } catch (err) {
            console.warn('[Auth] Logout blacklist failed:', err.message);
        }

        // إبطال refresh token
        const { refreshToken } = req.body || {};
        if (refreshToken) {
            const hash = JWTService.hashToken(refreshToken);
            await SystemDB.revokeRefreshToken(hash).catch(() => {});
            // استخرج family من refresh token لحذفه
            try {
                const p = JWTService.verifyRefreshToken(refreshToken);
                if (p?.family) await JWTService.deleteFamily(p.family);
            } catch {}
        }

        await SystemDB.log(req.user?.id, req.user?.username, 'LOGOUT', '', ip);
        res.json({ success: true, message: 'تم تسجيل الخروج بنجاح.' });
    }

    // ── POST /api/v1/auth/change-password ─────────────────────────────────────
    async changePassword(req, res) {
        const { oldPassword, newPassword } = req.body || {};
        if (!oldPassword || !newPassword || newPassword.length < 8)
            return res.status(400).json({ success: false, error: 'كلمة المرور الجديدة يجب أن تكون 8 أحرف على الأقل.' });

        const user  = await SystemDB.get(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
        const match = await bcrypt.compare(oldPassword, user.password);
        if (!match) return res.status(401).json({ success: false, error: 'كلمة المرور الحالية غير صحيحة.' });

        const hash = await bcrypt.hash(newPassword, 12);
        await SystemDB.run(`UPDATE users SET password = $1, updated_at = NOW() WHERE id = $2`, [hash, user.id]);
        await SystemDB.revokeAllUserTokens(user.id);

        await SystemDB.log(user.id, user.username, 'CHANGE_PASSWORD', '', this._ip(req));
        res.json({ success: true, message: 'تم تغيير كلمة المرور بنجاح. يرجى تسجيل الدخول من جديد.' });
    }

    // ── POST /api/v1/auth/mfa/setup ───────────────────────────────────────────
    async setupMFA(req, res) {
        try {
            const user = await SystemDB.get(`SELECT id, username, mfa_enabled FROM users WHERE id = $1`, [req.user.id]);
            if (user.mfa_enabled)
                return res.status(400).json({ success: false, error: 'المصادقة الثنائية مُفعَّلة بالفعل.' });

            const secret = speakeasy.generateSecret({
                name: `WhatsApp SaaS (${user.username})`,
                length: 20,
            });
            // [FIX-17] تشفير الـ MFA secret قبل الحفظ
            const encryptedSecret = EncryptionService.encrypt(secret.base32);
            await SystemDB.run(`UPDATE users SET mfa_secret = $1 WHERE id = $2`, [encryptedSecret, user.id]);

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

    // ── POST /api/v1/auth/mfa/verify ──────────────────────────────────────────
    async verifyMFA(req, res) {
        const { code } = req.body || {};
        if (!code) return res.status(400).json({ success: false, error: 'رمز MFA مطلوب.' });

        try {
            const user = await SystemDB.get(`SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1`, [req.user.id]);
            if (!user?.mfa_secret)
                return res.status(400).json({ success: false, error: 'لم يتم إعداد MFA بعد.' });

            // [FIX-17] فك تشفير الـ secret قبل التحقق
            const plainSecret = EncryptionService.decrypt(user.mfa_secret) || user.mfa_secret;
            const verified = speakeasy.totp.verify({
                secret:   plainSecret,
                encoding: 'base32',
                token:    code,
                window:   1,
            });
            if (!verified)
                return res.status(400).json({ success: false, error: 'الرمز غير صحيح.' });

            await SystemDB.run(`UPDATE users SET mfa_enabled = TRUE WHERE id = $1`, [req.user.id]);
            await SystemDB.log(req.user.id, req.user.username, 'MFA_ENABLED', '', this._ip(req));
            return res.json({ success: true, message: 'تم تفعيل المصادقة الثنائية بنجاح.' });
        } catch (err) {
            console.error('[Auth] MFA verify error:', err);
            return res.status(500).json({ success: false, error: 'خطأ في التحقق من MFA.' });
        }
    }

    // ── DELETE /api/v1/auth/mfa ───────────────────────────────────────────────
    async disableMFA(req, res) {
        const { code, password } = req.body || {};
        if (!code || !password)
            return res.status(400).json({ success: false, error: 'كلمة المرور ورمز MFA مطلوبان.' });

        try {
            const user      = await SystemDB.get(`SELECT * FROM users WHERE id = $1`, [req.user.id]);
            const passMatch = await bcrypt.compare(password, user.password);
            if (!passMatch) return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة.' });

            // [FIX-17] فك تشفير الـ secret
            const plainSecret = EncryptionService.decrypt(user.mfa_secret) || user.mfa_secret;
            const verified = speakeasy.totp.verify({
                secret:   plainSecret,
                encoding: 'base32',
                token:    code,
                window:   1,
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
