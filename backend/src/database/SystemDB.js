'use strict';
/**
 * SystemDB — PostgreSQL System-Level Database Singleton
 *
 * يُدير الجداول العامة للنظام (public schema):
 *   - accounts        : حسابات واتساب
 *   - users           : مستخدمو اللوحة
 *   - subscriptions   : الاشتراكات
 *   - licenses        : التراخيص
 *   - audit_log       : سجل العمليات
 *   - login_attempts  : محاولات تسجيل الدخول
 *   - refresh_tokens  : رموز التحديث
 *   - session_data    : بيانات جلسات واتساب
 */
const { query, queryOne, queryAll } = require('../lib/postgres');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');

class SystemDB {

    async init() {
        await query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id                  TEXT PRIMARY KEY,
                user_id             TEXT,
                phone_number        TEXT,
                name                TEXT NOT NULL,
                status              TEXT DEFAULT 'disconnected',
                health_status       TEXT DEFAULT 'unknown',
                role                TEXT DEFAULT 'stopped',
                task_status         TEXT DEFAULT 'idle',
                messages_sent_today INTEGER DEFAULT 0,
                last_activity_at    TIMESTAMP,
                created_at          TIMESTAMP DEFAULT NOW(),
                updated_at          TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id          TEXT PRIMARY KEY,
                username    TEXT UNIQUE NOT NULL,
                password    TEXT NOT NULL,
                full_name   TEXT,
                email       TEXT,
                role        TEXT DEFAULT 'user',
                status      TEXT DEFAULT 'active',
                mfa_enabled BOOLEAN DEFAULT FALSE,
                mfa_secret  TEXT,
                last_login  TIMESTAMP,
                created_at  TIMESTAMP DEFAULT NOW(),
                updated_at  TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                plan_type   TEXT DEFAULT 'basic',
                expires_at  TIMESTAMP,
                status      TEXT DEFAULT 'active',
                created_by  TEXT,
                created_at  TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id)`);
        await query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                license_key TEXT UNIQUE NOT NULL,
                status      TEXT DEFAULT 'active',
                issued_by   TEXT,
                note        TEXT,
                created_at  TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_lic_user ON licenses(user_id)`);
        await query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                user_id    TEXT,
                username   TEXT,
                action     TEXT,
                details    TEXT,
                ip         TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`);
        await query(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                username   TEXT NOT NULL,
                ip         TEXT,
                success    BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, created_at DESC)`);
        await query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                user_id     TEXT NOT NULL,
                token_hash  TEXT UNIQUE NOT NULL,
                ip          TEXT,
                user_agent  TEXT,
                expires_at  TIMESTAMP NOT NULL,
                revoked     BOOLEAN DEFAULT FALSE,
                created_at  TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash)`);
        await query(`
            CREATE TABLE IF NOT EXISTS session_data (
                account_id TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT,
                updated_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (account_id, key)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_sd_account ON session_data(account_id)`);
        console.log('[SystemDB] All system tables initialized (PostgreSQL).');
    }

    async seedSuperAdmin() {
        const existing = await queryOne(`SELECT id FROM users WHERE role = 'superadmin' LIMIT 1`);
        if (existing) return;
        const adminUser = process.env.ADMIN_USERNAME || 'admin';
        const adminPass = process.env.ADMIN_PASSWORD || 'Admin@123456';
        const hash      = await bcrypt.hash(adminPass, 12);
        const id        = crypto.randomUUID();
        await query(
            `INSERT INTO users (id, username, password, full_name, role, status)
             VALUES ($1, $2, $3, $4, 'superadmin', 'active')
             ON CONFLICT (username) DO NOTHING`,
            [id, adminUser, hash, 'Super Administrator']
        );
        console.log(`[SystemDB] Super-admin seeded: ${adminUser}`);
    }

    async get(sql, params = []) { return queryOne(sql, params); }
    async all(sql, params = []) { return queryAll(sql, params); }
    async run(sql, params = []) { return query(sql, params); }

    async log(userId, username, action, details = '', ip = null) {
        try {
            await query(
                `INSERT INTO audit_log (user_id, username, action, details, ip) VALUES ($1,$2,$3,$4,$5)`,
                [userId || null, username || null, action, details, ip]
            );
        } catch (err) { console.error('[SystemDB] Audit log error:', err.message); }
    }

    async recordAttempt(username, ip, success) {
        await query(
            `INSERT INTO login_attempts (username, ip, success) VALUES ($1,$2,$3)`,
            [username, ip, success]
        );
    }

    async isBlocked(username) {
        const row = await queryOne(
            `SELECT COUNT(*) as cnt FROM login_attempts
             WHERE username=$1 AND success=FALSE AND created_at > NOW() - INTERVAL '15 minutes'`,
            [username]
        );
        return parseInt(row?.cnt || 0, 10) >= 10;
    }

    async getActiveSubscription(userId) {
        return queryOne(
            `SELECT * FROM subscriptions
             WHERE user_id=$1 AND status='active' AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY expires_at DESC NULLS FIRST LIMIT 1`,
            [userId]
        );
    }

    async getDaysRemaining(sub) {
        if (!sub || !sub.expires_at) return null;
        const ms = new Date(sub.expires_at) - Date.now();
        return Math.max(0, Math.ceil(ms / 86400000));
    }

    async saveRefreshToken(userId, tokenHash, ip, userAgent, expiresAt) {
        await query(
            `INSERT INTO refresh_tokens (user_id, token_hash, ip, user_agent, expires_at)
             VALUES ($1,$2,$3,$4,$5)`,
            [userId, tokenHash, ip, userAgent, expiresAt]
        );
    }

    async findRefreshToken(tokenHash) {
        return queryOne(
            `SELECT * FROM refresh_tokens WHERE token_hash=$1 AND revoked=FALSE AND expires_at > NOW()`,
            [tokenHash]
        );
    }

    async revokeRefreshToken(tokenHash) {
        await query(`UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1`, [tokenHash]);
    }

    async revokeAllUserTokens(userId) {
        await query(`UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1`, [userId]);
    }

    async saveSessionData(accountId, key, value) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        await query(
            `INSERT INTO session_data (account_id, key, value, updated_at)
             VALUES ($1,$2,$3,NOW())
             ON CONFLICT (account_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
            [accountId, key, serialized]
        );
    }

    async getSessionData(accountId, key) {
        const row = await queryOne(
            `SELECT value FROM session_data WHERE account_id=$1 AND key=$2`,
            [accountId, key]
        );
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return row.value; }
    }

    async deleteSessionData(accountId, key) {
        await query(`DELETE FROM session_data WHERE account_id=$1 AND key=$2`, [accountId, key]);
    }

    async deleteAllSessionData(accountId) {
        await query(`DELETE FROM session_data WHERE account_id=$1`, [accountId]);
    }

    async updateAccountHealth(accountId, healthStatus) {
        await query(
            `UPDATE accounts SET health_status=$1, updated_at=NOW() WHERE id=$2`,
            [healthStatus, accountId]
        ).catch(err => console.error('[SystemDB] updateAccountHealth:', err.message));
    }

    async updateMessageStats(accountId) {
        await query(
            `UPDATE accounts SET messages_sent_today=messages_sent_today+1, last_activity_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [accountId]
        ).catch(err => console.error('[SystemDB] updateMessageStats:', err.message));
    }

    _generateLicenseKey() {
        return 'LIC-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    }
}

module.exports = new SystemDB();
