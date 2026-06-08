'use strict';
/**
 * SystemDB — PostgreSQL
 * Section 5.2 / 16.3 من وثيقة التحليل
 */
const { query, queryOne, queryAll } = require('../lib/postgres');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

// ── BufferJSON: serialization صحيح لـ Baileys session keys ──────────────────
// Baileys يخزن مفاتيح التشفير كـ Buffer/Uint8Array.
// JSON.stringify العادي يحوّلها لـ {0:1, 1:2, ...} → جلسة فاسدة → 500.
// BufferJSON يحفظها كـ {"type":"Buffer","data":[...]} ويستعيدها صحيحاً.
let _replacer, _reviver;
try {
    const { BufferJSON } = require('@whiskeysockets/baileys');
    _replacer = BufferJSON.replacer;
    _reviver  = BufferJSON.reviver;
} catch (_) {
    // fallback: نفس السلوك القديم إن لم تتوفر المكتبة
    _replacer = undefined;
    _reviver  = undefined;
}
const SESSION_STRINGIFY = (v) => JSON.stringify(v, _replacer);
const SESSION_PARSE     = (s) => {
    try { return JSON.parse(s, _reviver); }
    catch { return s; }
};

class SystemDB {

    async init() {
        console.log('[SystemDB] Initializing PostgreSQL tables...');

        // ── Users ─────────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id          TEXT PRIMARY KEY,
                username    TEXT UNIQUE NOT NULL,
                password    TEXT NOT NULL,
                email       TEXT,
                full_name   TEXT,
                role        TEXT    NOT NULL DEFAULT 'user',
                status      TEXT    NOT NULL DEFAULT 'active',
                mfa_secret  TEXT,
                mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
                last_login  TIMESTAMP,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);

        // ── Subscriptions ─────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                plan_type   TEXT NOT NULL,
                started_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                expires_at  TIMESTAMP,
                status      TEXT NOT NULL DEFAULT 'active',
                note        TEXT,
                created_by  TEXT,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // ── Licenses ──────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                license_key TEXT UNIQUE NOT NULL,
                status      TEXT NOT NULL DEFAULT 'active',
                issued_at   TIMESTAMP NOT NULL DEFAULT NOW(),
                issued_by   TEXT,
                note        TEXT,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);

        // ── Login Attempts (Brute-Force Protection) ───────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id          TEXT PRIMARY KEY,
                identifier  TEXT NOT NULL,
                ip_address  TEXT,
                success     BOOLEAN NOT NULL DEFAULT FALSE,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier
            ON login_attempts(identifier, created_at)
        `);

        // ── Temporary Blocks ──────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS login_blocks (
                identifier    TEXT PRIMARY KEY,
                blocked_until TIMESTAMP NOT NULL,
                created_at    TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);

        // ── Activity Logs ──────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id          TEXT PRIMARY KEY,
                user_id     TEXT,
                username    TEXT,
                action      TEXT NOT NULL,
                details     TEXT,
                ip_address  TEXT,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW()
            )
        `);

        // ── Refresh Tokens ─────────────────────────────────────────────────
        // Section 13.4: Access Token (15min) + Refresh Token (7 days) pattern
        await query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL,
                token_hash  TEXT UNIQUE NOT NULL,
                ip_address  TEXT,
                user_agent  TEXT,
                expires_at  TIMESTAMP NOT NULL,
                revoked     BOOLEAN NOT NULL DEFAULT FALSE,
                created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
            ON refresh_tokens(user_id, revoked)
        `);

        // ── WA Accounts ────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id                  TEXT PRIMARY KEY,
                user_id             TEXT,
                phone_number        TEXT,
                name                TEXT,
                status              TEXT DEFAULT 'disconnected',
                health_status       TEXT DEFAULT 'normal',
                messages_sent_today INTEGER DEFAULT 0,
                last_message_at     TIMESTAMP,
                warmup_phase        BOOLEAN DEFAULT TRUE,
                role                TEXT DEFAULT 'stopped',
                task_status         TEXT DEFAULT 'idle',
                last_activity_at    TIMESTAMP,
                updated_at          TIMESTAMP DEFAULT NOW(),
                created_at          TIMESTAMP DEFAULT NOW(),
                FOREIGN KEY(user_id) REFERENCES users(id)
            )
        `);

        // ── Migration: إضافة أعمدة الأدوار للحسابات القديمة ────────────────
        const existingCols = await query(`
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'accounts' AND table_schema = 'public'
        `).catch(() => ({ rows: [] }));
        const colNames = (existingCols.rows || []).map(r => r.column_name);

        if (!colNames.includes('role')) {
            await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'stopped'`);
            console.log('[SystemDB] Migration: added accounts.role column');
        }
        if (!colNames.includes('task_status')) {
            await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS task_status TEXT DEFAULT 'idle'`);
            console.log('[SystemDB] Migration: added accounts.task_status column');
        }
        if (!colNames.includes('last_activity_at')) {
            await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMP`);
            console.log('[SystemDB] Migration: added accounts.last_activity_at column');
        }
        if (!colNames.includes('updated_at')) {
            await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`);
            console.log('[SystemDB] Migration: added accounts.updated_at column');
        }

        // ── WhatsApp Sessions ──────────────────────────────────────────────
        // Section 7.2 Option A + 16.3 قرار #1:
        // تخزين Baileys session credentials في PostgreSQL بدلاً من FileSystem.
        // هذا يحل مشكلة فقدان الجلسات عند إعادة النشر على Railway.
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_sessions (
                account_id  TEXT NOT NULL,
                data_key    TEXT NOT NULL,
                data_value  TEXT,
                updated_at  TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (account_id, data_key)
            )
        `);
        await query(`
            CREATE INDEX IF NOT EXISTS idx_wa_sessions_account
            ON whatsapp_sessions(account_id)
        `);

        console.log('[SystemDB] All PostgreSQL tables initialized.');
    }

    // ── Super Admin Seeding ─────────────────────────────────────────────────
    async seedSuperAdmin() {
        const username = process.env.ADMIN_USERNAME || 'admin';
        const rawPwd   = process.env.ADMIN_PASSWORD || 'Admin@2025!';
        const existing = await this.get('SELECT id FROM users WHERE username = $1', [username]);
        if (existing) return;

        const hash = await bcrypt.hash(rawPwd, 12);
        const id   = uuidv4();

        await this.run(
            `INSERT INTO users (id,username,password,role,status,full_name) VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, username, hash, 'super_admin', 'active', 'Super Administrator']
        );

        // Lifetime subscription for super admin
        await this.run(
            `INSERT INTO subscriptions (id,user_id,plan_type,expires_at,status,created_by)
             VALUES ($1,$2,$3,NULL,'active',$4)`,
            [uuidv4(), id, 'lifetime', id]
        );

        // Issue license
        const licKey = this._generateLicenseKey();
        await this.run(
            `INSERT INTO licenses (id,user_id,license_key,status,issued_by) VALUES ($1,$2,$3,$4,$5)`,
            [uuidv4(), id, licKey, 'active', id]
        );

        console.log(`[SaaS] Super admin seeded: ${username}`);
    }

    _generateLicenseKey() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        const seg = () => Array.from({length:5}, () => chars[Math.floor(Math.random()*chars.length)]).join('');
        return `WA-${seg()}-${seg()}-${seg()}-${seg()}`;
    }

    // ── Subscription Helpers ────────────────────────────────────────────────
    async getActiveSubscription(userId) {
        return this.get(`
            SELECT * FROM subscriptions
            WHERE user_id = $1
              AND status = 'active'
              AND (expires_at IS NULL OR expires_at > NOW())
            ORDER BY expires_at DESC NULLS LAST LIMIT 1
        `, [userId]);
    }

    async getDaysRemaining(sub) {
        if (!sub) return 0;
        if (sub.plan_type === 'lifetime' || !sub.expires_at) return -1;
        const ms = new Date(sub.expires_at) - Date.now();
        return Math.max(0, Math.ceil(ms / 86400000));
    }

    // ── Login Brute-Force ───────────────────────────────────────────────────
    async isBlocked(identifier) {
        const block = await this.get(
            `SELECT * FROM login_blocks WHERE identifier = $1 AND blocked_until > NOW()`,
            [identifier]
        );
        return block || null;
    }

    async recordAttempt(identifier, ip, success) {
        await this.run(
            `INSERT INTO login_attempts (id,identifier,ip_address,success) VALUES ($1,$2,$3,$4)`,
            [uuidv4(), identifier, ip, success]
        );

        if (!success) {
            const cutoff = new Date(Date.now() - 30*60*1000);
            const row = await this.get(`
                SELECT COUNT(*) as cnt FROM login_attempts
                WHERE identifier = $1 AND success = FALSE AND created_at > $2
            `, [identifier, cutoff]);
            const count = parseInt(row?.cnt || '0', 10);
            if (count >= 5) {
                const until = new Date(Date.now() + 15*60*1000);
                await this.run(
                    `INSERT INTO login_blocks (identifier, blocked_until)
                     VALUES ($1, $2)
                     ON CONFLICT (identifier) DO UPDATE SET blocked_until = EXCLUDED.blocked_until`,
                    [identifier, until]
                );
            }
        } else {
            await this.run(`DELETE FROM login_blocks WHERE identifier = $1`, [identifier]);
        }
    }

    // ── Refresh Token Management ────────────────────────────────────────────
    async saveRefreshToken(userId, tokenHash, ip, userAgent, expiresAt) {
        await this.run(
            `INSERT INTO refresh_tokens (id, user_id, token_hash, ip_address, user_agent, expires_at)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv4(), userId, tokenHash, ip, userAgent, expiresAt]
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

    // ── WhatsApp Session Storage ────────────────────────────────────────────
    // Section 7.2 Option A: PostgreSQL Session Storage بدلاً من FileSystem
    async saveSessionData(accountId, dataKey, dataValue) {
        await this.run(
            `INSERT INTO whatsapp_sessions (account_id, data_key, data_value, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (account_id, data_key)
             DO UPDATE SET data_value = EXCLUDED.data_value, updated_at = NOW()`,
            [accountId, dataKey, SESSION_STRINGIFY(dataValue)]
        );
    }

    async getSessionData(accountId, dataKey) {
        const row = await this.get(
            `SELECT data_value FROM whatsapp_sessions WHERE account_id = $1 AND data_key = $2`,
            [accountId, dataKey]
        );
        if (!row) return null;
        return SESSION_PARSE(row.data_value);
    }

    async getAllSessionData(accountId) {
        const rows = await this.all(
            `SELECT data_key, data_value FROM whatsapp_sessions WHERE account_id = $1`,
            [accountId]
        );
        const result = {};
        for (const row of rows) {
            result[row.data_key] = SESSION_PARSE(row.data_value);
        }
        return result;
    }

    async deleteSessionData(accountId, dataKey) {
        await this.run(
            `DELETE FROM whatsapp_sessions WHERE account_id = $1 AND data_key = $2`,
            [accountId, dataKey]
        );
    }

    async deleteAllSessionData(accountId) {
        await this.run(
            `DELETE FROM whatsapp_sessions WHERE account_id = $1`,
            [accountId]
        );
    }

    // ── Activity Log ─────────────────────────────────────────────────────────
    async log(userId, username, action, details='', ip='') {
        await this.run(
            `INSERT INTO activity_logs (id,user_id,username,action,details,ip_address)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuidv4(), userId, username, action, details, ip]
        ).catch(() => {});
    }

    // ── Account Health Tracking ───────────────────────────────────────────────
    // Section 7.3: Anti-Ban — health status tracking
    async updateAccountHealth(accountId, healthStatus) {
        await this.run(
            `UPDATE accounts SET health_status = $1 WHERE id = $2`,
            [healthStatus, accountId]
        );
    }

    async updateMessageStats(accountId) {
        await this.run(
            `UPDATE accounts
             SET messages_sent_today = messages_sent_today + 1,
                 last_message_at = NOW()
             WHERE id = $1`,
            [accountId]
        );
    }

    async resetDailyMessageStats() {
        await this.run(
            `UPDATE accounts SET messages_sent_today = 0 WHERE TRUE`
        );
    }

    // ── Core DB Methods ───────────────────────────────────────────────────────
    async run(sql, params = []) {
        const res = await query(sql, params);
        return { changes: res.rowCount };
    }

    async get(sql, params = []) {
        return queryOne(sql, params);
    }

    async all(sql, params = []) {
        return queryAll(sql, params);
    }
}

module.exports = new SystemDB();
