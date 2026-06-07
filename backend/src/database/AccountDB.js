'use strict';
/**
 * AccountDB — PostgreSQL Schema-per-Tenant
 * Section 5.3 / 5.4 من وثيقة التحليل:
 * استراتيجية Schema-per-Tenant في PostgreSQL بدلاً من ملفات SQLite منفصلة.
 * كل حساب = Schema مستقل: account_{sanitized_id}
 * يحقق: عزل البيانات + Backup مشترك + يعمل مع Railway Multi-Process.
 */
const { getPool } = require('../lib/postgres');

class AccountDB {
    constructor(accountId) {
        this.accountId = accountId;
        // Sanitize UUID for PostgreSQL schema name (hyphens → underscores)
        this.schema = `"account_${accountId.replace(/-/g, '_')}"`;
    }

    /**
     * Execute a query within this account's schema.
     * Sets search_path to isolate tenant data automatically.
     */
    async _exec(fn) {
        const client = await getPool().connect();
        try {
            await client.query(`SET search_path TO ${this.schema}, public`);
            return await fn(client);
        } finally {
            // Reset search_path before returning client to pool
            try { await client.query(`SET search_path TO public`); } catch {}
            client.release();
        }
    }

    async init() {
        const client = await getPool().connect();
        try {
            // 1. Create schema for this tenant
            await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
            await client.query(`SET search_path TO ${this.schema}, public`);

            // ── Contacts (Groups) ────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS contacts (
                    id           TEXT PRIMARY KEY,
                    phone_number TEXT,
                    name         TEXT,
                    created_at   TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Groups ───────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS groups (
                    id         TEXT PRIMARY KEY,
                    group_id   TEXT UNIQUE,
                    name       TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Messages Log ─────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS messages (
                    id         TEXT PRIMARY KEY,
                    remote_jid TEXT,
                    message_id TEXT,
                    content    TEXT,
                    status     TEXT,
                    direction  TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Campaigns ────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS campaigns (
                    id               TEXT PRIMARY KEY,
                    name             TEXT,
                    ad_library_id    TEXT,
                    status           TEXT DEFAULT 'draft',
                    target_type      TEXT DEFAULT 'lists',
                    batch_size       INTEGER DEFAULT 50,
                    interval_seconds INTEGER DEFAULT 10,
                    daily_limit      INTEGER DEFAULT 1000,
                    scheduled_at     TIMESTAMP,
                    created_at       TIMESTAMP DEFAULT NOW(),
                    updated_at       TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Campaign Targets ─────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS campaign_targets (
                    id          TEXT PRIMARY KEY,
                    campaign_id TEXT,
                    target_jid  TEXT,
                    status      TEXT DEFAULT 'pending',
                    error_msg   TEXT,
                    sent_at     TIMESTAMP,
                    FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
                )
            `);

            // ── Campaign Exclusions ───────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS campaign_exclusions (
                    id          TEXT PRIMARY KEY,
                    campaign_id TEXT,
                    target_jid  TEXT,
                    reason      TEXT,
                    created_at  TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
                )
            `);

            // ── Contact Lists ─────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS contact_lists (
                    id          TEXT PRIMARY KEY,
                    name        TEXT,
                    description TEXT,
                    type        TEXT DEFAULT 'imported',
                    created_at  TIMESTAMP DEFAULT NOW(),
                    updated_at  TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Contacts (in lists) ───────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS list_contacts (
                    id         TEXT PRIMARY KEY,
                    list_id    TEXT,
                    jid        TEXT,
                    name       TEXT,
                    category   TEXT,
                    is_active  BOOLEAN DEFAULT TRUE,
                    opted_out  BOOLEAN DEFAULT FALSE,
                    created_at TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(list_id) REFERENCES contact_lists(id)
                )
            `);

            // ── Campaign <-> Lists Mapping ────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS campaign_lists (
                    campaign_id TEXT,
                    list_id     TEXT,
                    PRIMARY KEY (campaign_id, list_id),
                    FOREIGN KEY(campaign_id) REFERENCES campaigns(id),
                    FOREIGN KEY(list_id) REFERENCES contact_lists(id)
                )
            `);

            // ── Campaign Logs ─────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS campaign_logs (
                    id          TEXT PRIMARY KEY,
                    campaign_id TEXT,
                    level       TEXT,
                    message     TEXT,
                    created_at  TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(campaign_id) REFERENCES campaigns(id)
                )
            `);

            // ── Scheduled Tasks (BullMQ audit log — BullMQ runs jobs in Redis) ──
            // Section 9.3: BullMQ يُدير التنفيذ الفعلي في Redis.
            // هذا الجدول للتدقيق والتاريخ فقط.
            await client.query(`
                CREATE TABLE IF NOT EXISTS task_audit_log (
                    id         TEXT PRIMARY KEY,
                    bull_job_id TEXT,
                    type       TEXT,
                    payload    TEXT,
                    status     TEXT DEFAULT 'queued',
                    priority   INTEGER DEFAULT 0,
                    execute_at TIMESTAMP,
                    completed_at TIMESTAMP,
                    error_msg  TEXT,
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Link Categories ───────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS link_categories (
                    id    TEXT PRIMARY KEY,
                    name  TEXT UNIQUE,
                    color TEXT DEFAULT '#ffffff'
                )
            `);

            // ── Extracted Links ───────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS extracted_links (
                    id           TEXT PRIMARY KEY,
                    url          TEXT,
                    domain       TEXT,
                    group_jid    TEXT,
                    sender_jid   TEXT,
                    message_id   TEXT,
                    category_id  TEXT,
                    ai_rating    INTEGER DEFAULT 0,
                    ai_summary   TEXT,
                    is_spam      BOOLEAN DEFAULT FALSE,
                    country      TEXT,
                    region       TEXT,
                    keywords     TEXT,
                    status       TEXT DEFAULT 'active',
                    extracted_at TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(category_id) REFERENCES link_categories(id)
                )
            `);

            // ── Auto Join Queue ───────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS auto_join_queue (
                    id                TEXT PRIMARY KEY,
                    link_id           TEXT,
                    invite_code       TEXT,
                    status            TEXT DEFAULT 'pending',
                    target_account_id TEXT,
                    scheduled_at      TIMESTAMP,
                    joined_at         TIMESTAMP,
                    error_msg         TEXT,
                    created_at        TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(link_id) REFERENCES extracted_links(id)
                )
            `);

            // ── Link Search Settings ──────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS link_search_settings (
                    id                   TEXT PRIMARY KEY DEFAULT 'default',
                    allowed_account_ids  TEXT DEFAULT '[]',
                    allowed_group_jids   TEXT DEFAULT '[]',
                    deep_search_enabled  BOOLEAN DEFAULT FALSE,
                    search_by_date_from  TIMESTAMP,
                    search_by_date_to    TIMESTAMP,
                    filter_country       TEXT,
                    filter_domain        TEXT,
                    filter_region        TEXT,
                    updated_at           TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Auto Join Settings ────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS auto_join_settings (
                    id                        TEXT PRIMARY KEY DEFAULT 'default',
                    allowed_account_ids       TEXT DEFAULT '[]',
                    max_joins_per_day         INTEGER DEFAULT 10,
                    delay_between_joins_minutes INTEGER DEFAULT 5,
                    exclude_banned            BOOLEAN DEFAULT TRUE,
                    enabled                   BOOLEAN DEFAULT TRUE,
                    updated_at                TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Ad Library ────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS ad_library (
                    id             TEXT PRIMARY KEY,
                    name           TEXT NOT NULL,
                    content        TEXT,
                    media_paths    TEXT DEFAULT '[]',
                    media_types    TEXT DEFAULT '[]',
                    links          TEXT DEFAULT '[]',
                    format_options TEXT DEFAULT '{}',
                    priority       INTEGER DEFAULT 5,
                    tags           TEXT,
                    is_active      BOOLEAN DEFAULT TRUE,
                    times_used     INTEGER DEFAULT 0,
                    last_used_at   TIMESTAMP,
                    created_at     TIMESTAMP DEFAULT NOW(),
                    updated_at     TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Broadcast Schedules ───────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS broadcast_schedules (
                    id               TEXT PRIMARY KEY,
                    name             TEXT NOT NULL,
                    account_id       TEXT NOT NULL,
                    target_group_jids TEXT DEFAULT '[]',
                    ad_library_ids   TEXT DEFAULT '[]',
                    rotation_mode    TEXT DEFAULT 'sequential',
                    active_days      TEXT DEFAULT '[0,1,2,3,4,5,6]',
                    publish_times    TEXT DEFAULT '[]',
                    max_per_day      INTEGER DEFAULT 3,
                    status           TEXT DEFAULT 'paused',
                    last_run_at      TIMESTAMP,
                    next_run_at      TIMESTAMP,
                    executions_done  INTEGER DEFAULT 0,
                    created_at       TIMESTAMP DEFAULT NOW(),
                    updated_at       TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Direct Publish Log ────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS direct_publish_log (
                    id               TEXT PRIMARY KEY,
                    account_id       TEXT,
                    ad_library_id    TEXT,
                    target_group_jids TEXT DEFAULT '[]',
                    custom_content   TEXT,
                    media_path       TEXT,
                    status           TEXT DEFAULT 'sent',
                    sent_at          TIMESTAMP DEFAULT NOW(),
                    error_msg        TEXT
                )
            `);

            // ── Link Logs ─────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS link_logs (
                    id         TEXT PRIMARY KEY,
                    link_id    TEXT,
                    action     TEXT,
                    details    TEXT,
                    created_at TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(link_id) REFERENCES extracted_links(id)
                )
            `);

            // ── Scheduled Messages ─────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS scheduled_messages (
                    id               TEXT PRIMARY KEY,
                    name             TEXT,
                    content          TEXT,
                    media_path       TEXT,
                    media_type       TEXT,
                    target_type      TEXT DEFAULT 'group',
                    target_jid       TEXT,
                    status           TEXT DEFAULT 'pending',
                    priority         INTEGER DEFAULT 5,
                    scheduled_at     TIMESTAMP,
                    repeat_type      TEXT DEFAULT 'none',
                    repeat_interval  INTEGER DEFAULT 0,
                    repeat_until     TIMESTAMP,
                    repeat_count     INTEGER DEFAULT 0,
                    executions_done  INTEGER DEFAULT 0,
                    last_executed_at TIMESTAMP,
                    timezone         TEXT DEFAULT 'Asia/Riyadh',
                    tags             TEXT,
                    notes            TEXT,
                    created_at       TIMESTAMP DEFAULT NOW(),
                    updated_at       TIMESTAMP DEFAULT NOW()
                )
            `);

            // ── Schedule Logs ─────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS schedule_logs (
                    id          TEXT PRIMARY KEY,
                    schedule_id TEXT,
                    level       TEXT,
                    message     TEXT,
                    created_at  TIMESTAMP DEFAULT NOW(),
                    FOREIGN KEY(schedule_id) REFERENCES scheduled_messages(id)
                )
            `);

            // ── Settings ───────────────────────────────────────────────────────
            await client.query(`
                CREATE TABLE IF NOT EXISTS settings (
                    key   TEXT PRIMARY KEY,
                    value TEXT
                )
            `);

            // ── Performance Indexes ────────────────────────────────────────────
            await client.query(`CREATE INDEX IF NOT EXISTS idx_campaign_targets_status ON campaign_targets(status)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_extracted_links_status  ON extracted_links(status)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_scheduled_msgs_status   ON scheduled_messages(status, scheduled_at)`);

            console.log(`[AccountDB] Schema ${this.schema} initialized.`);
        } finally {
            try { await client.query(`SET search_path TO public`); } catch {}
            client.release();
        }
    }

    // ── Query Helpers ─────────────────────────────────────────────────────────
    async run(sql, params = []) {
        return this._exec(async (client) => {
            const res = await client.query(sql, params);
            return { changes: res.rowCount };
        });
    }

    async get(sql, params = []) {
        return this._exec(async (client) => {
            const res = await client.query(sql, params);
            return res.rows[0] || null;
        });
    }

    async all(sql, params = []) {
        return this._exec(async (client) => {
            const res = await client.query(sql, params);
            return res.rows;
        });
    }

    async close() {
        // No-op: pool connections are managed globally
    }
}

module.exports = AccountDB;
