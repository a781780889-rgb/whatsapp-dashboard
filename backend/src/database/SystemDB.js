'use strict';
/**
 * SystemDB — قاعدة البيانات النظامية (Public Schema)
 * يُدير الجداول المشتركة: المستخدمون، الحسابات، الاشتراكات، الرخص،
 * جلسات WhatsApp، محاولات الدخول، السجلات الأمنية، Refresh Tokens.
 */
const { getPool } = require('../lib/postgres');
const crypto      = require('crypto');
const bcrypt      = require('bcryptjs');

// عدد المحاولات الفاشلة قبل الحظر المؤقت
const MAX_ATTEMPTS  = 5;
const BLOCK_MINUTES = 15;

class SystemDB {

    // ═══════════════════════════════════════════════════════════════════════════
    //  Query Helpers
    // ═══════════════════════════════════════════════════════════════════════════
    async run(sql, params = []) {
        const client = await getPool().connect();
        try {
            const res = await client.query(sql, params);
            return { changes: res.rowCount };
        } finally {
            client.release();
        }
    }

    async get(sql, params = []) {
        const client = await getPool().connect();
        try {
            const res = await client.query(sql, params);
            return res.rows[0] || null;
        } finally {
            client.release();
        }
    }

    async all(sql, params = []) {
        const client = await getPool().connect();
        try {
            const res = await client.query(sql, params);
            return res.rows;
        } finally {
            client.release();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  init() — تهيئة جميع جداول النظام
    // ═══════════════════════════════════════════════════════════════════════════
    async init() {
        const client = await getPool().connect();
        try {
            // ── Users ────────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id          TEXT PRIMARY KEY,
                    username    TEXT UNIQUE NOT NULL,
                    password    TEXT NOT NULL,
                    full_name   TEXT DEFAULT '',
                    email       TEXT DEFAULT '',
                    role        TEXT DEFAULT 'user',
                    status      TEXT DEFAULT 'active',
                    mfa_enabled BOOLEAN DEFAULT FALSE,
                    mfa_secret  TEXT,
                    last_login  TIMESTAMP,
                    created_at  TIMESTAMP DEFAULT NOW(),
                    updated_at  TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── WhatsApp Accounts ────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS accounts (
                    id                  TEXT PRIMARY KEY,
                    user_id             TEXT REFERENCES users(id) ON DELETE SET NULL,
                    phone_number        TEXT DEFAULT '',
                    name                TEXT DEFAULT '',
                    status              TEXT DEFAULT 'disconnected',
                    health_status       TEXT DEFAULT 'normal',
                    role                TEXT DEFAULT 'stopped',
                    task_status         TEXT DEFAULT 'idle',
                    warmup_phase        BOOLEAN DEFAULT FALSE,
                    messages_sent_today INTEGER DEFAULT 0,
                    last_activity_at    TIMESTAMP,
                    created_at          TIMESTAMP DEFAULT NOW(),
                    updated_at          TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Subscriptions ─────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS subscriptions (
                    id          TEXT PRIMARY KEY,
                    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
                    plan_type   TEXT DEFAULT 'monthly',
                    status      TEXT DEFAULT 'active',
                    expires_at  TIMESTAMP,
                    created_by  TEXT,
                    created_at  TIMESTAMP DEFAULT NOW(),
                    updated_at  TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Licenses ──────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS licenses (
                    id          TEXT PRIMARY KEY,
                    user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
                    license_key TEXT UNIQUE NOT NULL,
                    status      TEXT DEFAULT 'active',
                    issued_by   TEXT,
                    note        TEXT,
                    issued_at   TIMESTAMP DEFAULT NOW(),
                    revoked_at  TIMESTAMP
                )
            `);

            // ── Audit Logs ────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    user_id    TEXT,
                    username   TEXT,
                    action     TEXT,
                    details    TEXT,
                    ip         TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Login Attempts (Brute-Force Protection) ───────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS login_attempts (
                    id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    username      TEXT NOT NULL,
                    ip            TEXT,
                    success       BOOLEAN DEFAULT FALSE,
                    blocked_until TIMESTAMP,
                    attempt_count INTEGER DEFAULT 1,
                    created_at    TIMESTAMP DEFAULT NOW(),
                    updated_at    TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Refresh Tokens (Section 15.1) ─────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS refresh_tokens (
                    id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    user_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
                    token_hash TEXT UNIQUE NOT NULL,
                    ip         TEXT,
                    user_agent TEXT,
                    expires_at TIMESTAMP NOT NULL,
                    revoked    BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── WhatsApp Session Data (Baileys Auth State) ────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS whatsapp_session_data (
                    id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                    account_id  TEXT NOT NULL,
                    data_key    TEXT NOT NULL,
                    data_value  TEXT,
                    updated_at  TIMESTAMP DEFAULT NOW(),
                    UNIQUE(account_id, data_key)
                )
            `);

            // ── Schema Migrations (safe for existing deployments) ────────────
            // يُصلح مشكلة "column does not exist" عند الترقية من نسخ قديمة.
            // CREATE TABLE IF NOT EXISTS لا تُضيف أعمدة جديدة للجداول الموجودة،
            // لذا نستخدم ALTER TABLE ADD COLUMN IF NOT EXISTS قبل إنشاء الـ indexes.
            const schemaMigrations = [
                // login_attempts: username وجد لاحقاً في بعض النشرات
                `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS username      TEXT DEFAULT ''`,
                `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS ip            TEXT`,
                `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS success       BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS blocked_until TIMESTAMP`,
                `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS attempt_count INTEGER DEFAULT 1`,
                `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS updated_at    TIMESTAMP DEFAULT NOW()`,
                // users: أعمدة MFA وجدت لاحقاً
                `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret  TEXT`,
                `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login  TIMESTAMP`,
                `ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMP DEFAULT NOW()`,
                // accounts: أعمدة health وجدت لاحقاً
                `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_status       TEXT DEFAULT 'normal'`,
                `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_phase        BOOLEAN DEFAULT FALSE`,
                `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS task_status         TEXT DEFAULT 'idle'`,
                `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS messages_sent_today INTEGER DEFAULT 0`,
            ];
            for (const sql of schemaMigrations) {
                await client.query(sql).catch(err =>
                    console.warn(`[SystemDB] Migration skipped: ${err.message}`)
                );
            }

            // ── Performance Indexes ───────────────────────────────────────────
            await client.query(`CREATE INDEX IF NOT EXISTS idx_accounts_status       ON accounts(status)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user    ON subscriptions(user_id, status)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_user       ON audit_logs(user_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_login_attempts_user   ON login_attempts(username, updated_at)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash   ON refresh_tokens(token_hash)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_session_data_account  ON whatsapp_session_data(account_id)`);

            console.log('[SystemDB] System tables initialized (PostgreSQL).');
        } finally {
            client.release();
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  seedSuperAdmin() — إنشاء حساب super_admin إذا لم يوجد
    // ═══════════════════════════════════════════════════════════════════════════
    async seedSuperAdmin() {
        const existing = await this.get(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
        if (existing) return;

        const adminUser     = process.env.ADMIN_USERNAME || 'admin';
        const adminPassword = process.env.ADMIN_PASSWORD || 'Admin@123';
        const hashed        = await bcrypt.hash(adminPassword, 12);
        const id            = crypto.randomUUID();

        await this.run(
            `INSERT INTO users (id, username, password, full_name, role, status)
             VALUES ($1, $2, $3, 'Super Administrator', 'super_admin', 'active')
             ON CONFLICT (username) DO NOTHING`,
            [id, adminUser, hashed]
        );
        console.log(`[SystemDB] Super admin seeded: ${adminUser}`);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Audit Log
    // ═══════════════════════════════════════════════════════════════════════════
    async log(userId, username, action, details = '', ip = '') {
        await this.run(
            `INSERT INTO audit_logs (user_id, username, action, details, ip)
             VALUES ($1, $2, $3, $4, $5)`,
            [userId || null, username || '', action, details, ip]
        ).catch(err => console.error('[SystemDB] Audit log error:', err.message));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Brute-Force Protection
    // ═══════════════════════════════════════════════════════════════════════════
    async isBlocked(username) {
        return this.get(
            `SELECT blocked_until FROM login_attempts
             WHERE username = $1
               AND blocked_until IS NOT NULL
               AND blocked_until > NOW()
             ORDER BY updated_at DESC LIMIT 1`,
            [username]
        );
    }

    async recordAttempt(username, ip, success) {
        if (success) {
            // مسح سجل المحاولات عند النجاح
            await this.run(
                `DELETE FROM login_attempts WHERE username = $1`, [username]
            ).catch(() => {});
            return;
        }

        // احسب عدد المحاولات الفاشلة خلال آخر ساعة
        const row = await this.get(
            `SELECT id, attempt_count FROM login_attempts
             WHERE username = $1 AND created_at > NOW() - INTERVAL '1 hour'
             ORDER BY created_at DESC LIMIT 1`,
            [username]
        );

        if (row) {
            const newCount     = (row.attempt_count || 0) + 1;
            const blockedUntil = newCount >= MAX_ATTEMPTS
                ? new Date(Date.now() + BLOCK_MINUTES * 60 * 1000)
                : null;
            await this.run(
                `UPDATE login_attempts SET attempt_count=$1, blocked_until=$2, ip=$3, updated_at=NOW()
                 WHERE id=$4`,
                [newCount, blockedUntil, ip, row.id]
            ).catch(() => {});
        } else {
            await this.run(
                `INSERT INTO login_attempts (username, ip, success, attempt_count)
                 VALUES ($1, $2, FALSE, 1)`,
                [username, ip]
            ).catch(() => {});
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Subscriptions
    // ═══════════════════════════════════════════════════════════════════════════
    async getActiveSubscription(userId) {
        return this.get(
            `SELECT * FROM subscriptions
             WHERE user_id = $1
               AND status = 'active'
               AND (expires_at IS NULL OR expires_at > NOW() OR plan_type = 'lifetime')
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        );
    }

    async getDaysRemaining(sub) {
        if (!sub) return 0;
        if (sub.plan_type === 'lifetime' || !sub.expires_at) return -1; // -1 = unlimited
        const ms   = new Date(sub.expires_at).getTime() - Date.now();
        const days = Math.ceil(ms / (1000 * 60 * 60 * 24));
        return Math.max(0, days);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Refresh Tokens (Section 15.1)
    // ═══════════════════════════════════════════════════════════════════════════
    async saveRefreshToken(userId, tokenHash, ip, userAgent, expiresAt) {
        await this.run(
            `INSERT INTO refresh_tokens (user_id, token_hash, ip, user_agent, expires_at)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (token_hash) DO UPDATE
             SET expires_at=$5, revoked=FALSE, created_at=NOW()`,
            [userId, tokenHash, ip, userAgent, expiresAt]
        );
    }

    async findRefreshToken(tokenHash) {
        return this.get(
            `SELECT * FROM refresh_tokens
             WHERE token_hash = $1 AND revoked = FALSE AND expires_at > NOW()`,
            [tokenHash]
        );
    }

    async revokeRefreshToken(tokenHash) {
        await this.run(
            `UPDATE refresh_tokens SET revoked = TRUE WHERE token_hash = $1`,
            [tokenHash]
        );
    }

    async revokeAllUserTokens(userId) {
        await this.run(
            `UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`,
            [userId]
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  WhatsApp Session Data (Baileys Auth State)
    // ═══════════════════════════════════════════════════════════════════════════
    async getSessionData(accountId, key) {
        const row = await this.get(
            `SELECT data_value FROM whatsapp_session_data
             WHERE account_id = $1 AND data_key = $2`,
            [accountId, key]
        );
        if (!row) return null;
        try { return JSON.parse(row.data_value); } catch { return row.data_value; }
    }

    async saveSessionData(accountId, key, value) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        await this.run(
            `INSERT INTO whatsapp_session_data (account_id, data_key, data_value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (account_id, data_key)
             DO UPDATE SET data_value = $3, updated_at = NOW()`,
            [accountId, key, serialized]
        );
    }

    async deleteSessionData(accountId, key) {
        await this.run(
            `DELETE FROM whatsapp_session_data WHERE account_id = $1 AND data_key = $2`,
            [accountId, key]
        );
    }

    async deleteAllSessionData(accountId) {
        await this.run(
            `DELETE FROM whatsapp_session_data WHERE account_id = $1`,
            [accountId]
        );
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Account Health & Message Stats
    // ═══════════════════════════════════════════════════════════════════════════
    async updateAccountHealth(accountId, healthStatus) {
        await this.run(
            `UPDATE accounts SET health_status = $1, updated_at = NOW() WHERE id = $2`,
            [healthStatus, accountId]
        ).catch(err => console.warn('[SystemDB] updateAccountHealth:', err.message));
    }

    async updateMessageStats(accountId) {
        await this.run(
            `UPDATE accounts
             SET messages_sent_today = COALESCE(messages_sent_today, 0) + 1,
                 last_activity_at    = NOW(),
                 updated_at          = NOW()
             WHERE id = $1`,
            [accountId]
        ).catch(err => console.warn('[SystemDB] updateMessageStats:', err.message));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  License Key Generator
    // ═══════════════════════════════════════════════════════════════════════════
    _generateLicenseKey() {
        const seg = () => crypto.randomBytes(4).toString('hex').toUpperCase();
        return `${seg()}-${seg()}-${seg()}-${seg()}`;
    }
}

module.exports = new SystemDB();
