'use strict';
/**
 * AuthController.test.js
 * المرحلة 8: Code Quality — FIX-29: Unit Tests
 *
 * يختبر:
 *   1. login — نجاح تسجيل الدخول
 *   2. login — مستخدم غير موجود
 *   3. login — كلمة مرور خاطئة
 *   4. login — حساب مقفل
 *   5. login — MFA مطلوب
 *   6. login — MFA فاشل
 *   7. refreshToken — تجديد ناجح
 *   8. refreshToken — token منتهي الصلاحية
 *   9. logout — ناجح
 *   10. changePassword — كلمة مرور قصيرة (validation)
 */

const bcrypt = require('bcryptjs');

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockSystemDB = {
    isBlocked:     jest.fn(),
    get:           jest.fn(),
    run:           jest.fn(),
    recordAttempt: jest.fn(),
    log:           jest.fn(),
};

const mockJWTService = {
    generateTokenPair:  jest.fn(),
    verifyRefreshToken: jest.fn(),
    revokeFamily:       jest.fn(),
    revokeToken:        jest.fn(),
};

const mockEncryptionService = {
    encryptUserData: jest.fn(d => d),
    decryptUserData: jest.fn(d => d),
};

jest.mock('../database/SystemDB',       () => mockSystemDB);
jest.mock('../core/JWTService',         () => mockJWTService);
jest.mock('../core/EncryptionService',  () => mockEncryptionService);
jest.mock('speakeasy', () => ({
    totp: {
        verify: jest.fn(),
    },
}));
jest.mock('qrcode', () => ({ toDataURL: jest.fn() }));

const AuthController = require('../api/controllers/AuthController');
const ctrl = new AuthController();

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReq(body = {}, user = null) {
    return {
        body,
        user,
        headers: { 'x-forwarded-for': '127.0.0.1' },
        socket:  { remoteAddress: '127.0.0.1' },
    };
}

function makeRes() {
    const res = {
        _status: 200,
        _body:   null,
        status: jest.fn(function(s) { this._status = s; return this; }),
        json:   jest.fn(function(b) { this._body   = b; return this; }),
    };
    return res;
}

// كلمة مرور وهمية مُشفَّرة
let HASHED_PASSWORD;

beforeAll(async () => {
    HASHED_PASSWORD = await bcrypt.hash('SecurePass123', 10);
});

beforeEach(() => {
    jest.clearAllMocks();
});

// ── الاختبارات ────────────────────────────────────────────────────────────────

describe('AuthController — login()', () => {

    test('✅ نجاح تسجيل الدخول — يُعيد tokens', async () => {
        mockSystemDB.isBlocked.mockResolvedValue(null);
        mockSystemDB.get.mockImplementation(async (sql) => {
            if (sql.includes('FROM users')) {
                return {
                    id: 'user-1', username: 'admin', password: HASHED_PASSWORD,
                    role: 'admin', status: 'active', mfa_enabled: false,
                    failed_login_count: 0, locked_until: null,
                };
            }
            return null;
        });
        mockSystemDB.run.mockResolvedValue({});
        mockSystemDB.log.mockResolvedValue({});
        mockSystemDB.recordAttempt.mockResolvedValue({});
        mockJWTService.generateTokenPair.mockResolvedValue({
            accessToken:  'access.token.here',
            refreshToken: 'refresh.token.here',
            family:       'fam-1',
        });

        const req = makeReq({ username: 'admin', password: 'SecurePass123' });
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._status).toBe(200);
        expect(res._body.success).toBe(true);
        expect(res._body.accessToken).toBe('access.token.here');
    });

    test('❌ مستخدم غير موجود — 401', async () => {
        mockSystemDB.isBlocked.mockResolvedValue(null);
        mockSystemDB.get.mockResolvedValue(null);
        mockSystemDB.recordAttempt.mockResolvedValue({});
        mockSystemDB.log.mockResolvedValue({});

        const req = makeReq({ username: 'ghost', password: 'any' });
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._status).toBe(401);
        expect(res._body.success).toBe(false);
    });

    test('❌ كلمة مرور خاطئة — 401', async () => {
        mockSystemDB.isBlocked.mockResolvedValue(null);
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', username: 'admin', password: HASHED_PASSWORD,
            role: 'admin', status: 'active', mfa_enabled: false,
            failed_login_count: 0, locked_until: null,
        });
        mockSystemDB.run.mockResolvedValue({});
        mockSystemDB.recordAttempt.mockResolvedValue({});
        mockSystemDB.log.mockResolvedValue({});

        const req = makeReq({ username: 'admin', password: 'WrongPass' });
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._status).toBe(401);
        expect(res._body.success).toBe(false);
    });

    test('❌ حساب مقفل — 429', async () => {
        mockSystemDB.isBlocked.mockResolvedValue(null);
        const lockedUntil = new Date(Date.now() + 10 * 60000).toISOString();
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', username: 'admin', password: HASHED_PASSWORD,
            role: 'admin', status: 'active', mfa_enabled: false,
            failed_login_count: 5, locked_until: lockedUntil,
        });

        const req = makeReq({ username: 'admin', password: 'any' });
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._status).toBe(429);
    });

    test('⚠️  MFA مطلوب — 200 مع requiresMFA:true', async () => {
        mockSystemDB.isBlocked.mockResolvedValue(null);
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', username: 'admin', password: HASHED_PASSWORD,
            role: 'admin', status: 'active',
            mfa_enabled: true, mfa_secret: 'JBSWY3DPEHPK3PXP',
            failed_login_count: 0, locked_until: null,
        });
        mockSystemDB.run.mockResolvedValue({});

        const req = makeReq({ username: 'admin', password: 'SecurePass123' });
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._body.requiresMFA).toBe(true);
    });

    test('❌ MFA خاطئ — 401', async () => {
        mockSystemDB.isBlocked.mockResolvedValue(null);
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', username: 'admin', password: HASHED_PASSWORD,
            role: 'admin', status: 'active',
            mfa_enabled: true, mfa_secret: 'JBSWY3DPEHPK3PXP',
            failed_login_count: 0, locked_until: null,
        });
        mockSystemDB.run.mockResolvedValue({});
        mockSystemDB.recordAttempt.mockResolvedValue({});
        mockSystemDB.log.mockResolvedValue({});

        const speakeasy = require('speakeasy');
        speakeasy.totp.verify.mockReturnValue(false);

        const req = makeReq({ username: 'admin', password: 'SecurePass123', mfaCode: '000000' });
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._status).toBe(401);
    });

    test('❌ بيانات ناقصة — 400', async () => {
        const req = makeReq({ username: 'admin' }); // بدون password
        const res = makeRes();

        await ctrl.login(req, res);

        expect(res._status).toBe(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('AuthController — refreshToken()', () => {

    test('✅ تجديد ناجح — يُعيد access token جديد', async () => {
        mockJWTService.verifyRefreshToken.mockResolvedValue({
            userId: 'user-1', family: 'fam-1', tokenId: 'tid-1',
        });
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', username: 'admin', role: 'admin', status: 'active',
        });
        mockJWTService.generateTokenPair.mockResolvedValue({
            accessToken: 'new.access', refreshToken: 'new.refresh', family: 'fam-1',
        });

        const req = makeReq({ refreshToken: 'valid.refresh.token' });
        const res = makeRes();

        await ctrl.refreshToken(req, res);

        expect(res._body?.accessToken).toBe('new.access');
    });

    test('❌ refresh token غير صالح — 401', async () => {
        mockJWTService.verifyRefreshToken.mockRejectedValue(new Error('invalid token'));

        const req = makeReq({ refreshToken: 'bad.token' });
        const res = makeRes();

        await ctrl.refreshToken(req, res);

        expect(res._status).toBe(401);
        expect(res._body.success).toBe(false);
    });

    test('❌ بدون refreshToken — 400', async () => {
        const req = makeReq({});
        const res = makeRes();

        await ctrl.refreshToken(req, res);

        expect(res._status).toBe(400);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('AuthController — logout()', () => {

    test('✅ تسجيل خروج — يُبطل الـ token', async () => {
        mockJWTService.revokeToken.mockResolvedValue(true);
        mockSystemDB.log.mockResolvedValue({});

        const req = makeReq(
            { refreshToken: 'some.token' },
            { id: 'user-1', username: 'admin' }
        );
        const res = makeRes();

        await ctrl.logout(req, res);

        expect(res._body?.success).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('AuthController — changePassword()', () => {

    test('❌ كلمة المرور الجديدة قصيرة جداً — 400', async () => {
        const req = makeReq(
            { currentPassword: 'OldPass123', newPassword: '123' },
            { id: 'user-1' }
        );
        const res = makeRes();

        await ctrl.changePassword(req, res);

        expect(res._status).toBe(400);
        expect(res._body.success).toBe(false);
    });

    test('❌ كلمة المرور الحالية خاطئة — 401', async () => {
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', password: HASHED_PASSWORD,
        });

        const req = makeReq(
            { currentPassword: 'WrongOld', newPassword: 'NewSecurePass123' },
            { id: 'user-1' }
        );
        const res = makeRes();

        await ctrl.changePassword(req, res);

        expect(res._status).toBe(401);
    });

    test('✅ تغيير كلمة المرور بنجاح', async () => {
        mockSystemDB.get.mockResolvedValue({
            id: 'user-1', password: HASHED_PASSWORD,
        });
        mockSystemDB.run.mockResolvedValue({});
        mockSystemDB.log.mockResolvedValue({});
        mockJWTService.revokeFamily.mockResolvedValue(true);

        const req = makeReq(
            { currentPassword: 'SecurePass123', newPassword: 'NewSecurePass456' },
            { id: 'user-1', username: 'admin' }
        );
        const res = makeRes();

        await ctrl.changePassword(req, res);

        expect(res._body?.success).toBe(true);
    });
});
