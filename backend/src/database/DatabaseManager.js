'use strict';
/**
 * DatabaseManager — Per-Account PostgreSQL Schema Manager
 */
const { Pool } = require('pg');
const SystemDB = require('./SystemDB');

let pool = null;

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
            max: 10,
            idleTimeoutMillis: 60000,
            connectionTimeoutMillis: 10000,
            keepAlive: true,
        });
        pool.on('error', (err) => console.error('[DatabaseManager] Pool error:', err.message));
    }
    return pool;
}

const accountDBs = new Map();

function createAccountDB(accountId, schemaName) {
    const p = getPool();
    return {
        accountId,
        schemaName,
        async query(sql, params = []) {
            const client = await p.connect();
            try {
                await client.query(`SET search_path TO "${schemaName}", public`);
                return await client.query(sql, params);
            } finally {
                client.release();
            }
        },
        async get(sql, params = []) {
            const r = await this.query(sql, params);
            return r.rows[0] || null;
        },
        async all(sql, params = []) {
            const r = await this.query(sql, params);
            return r.rows;
        },
        async run(sql, params = []) {
            const r = await this.query(sql, params);
            return { rowCount: r.rowCount };
        },
    };
}

const ACCOUNT_SCHEMA = (s) => `
CREATE SCHEMA IF NOT EXISTS "${s}";
SET search_path TO "${s}", public;

CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT, description TEXT, participant_count INT DEFAULT 0, category TEXT DEFAULT 'general', is_active BOOLEAN DEFAULT TRUE, joined_at TIMESTAMPTZ DEFAULT NOW(), last_sync_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS group_members (group_id TEXT, phone TEXT NOT NULL, name TEXT, is_admin BOOLEAN DEFAULT FALSE, joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (group_id, phone));
CREATE TABLE IF NOT EXISTS links (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), url TEXT NOT NULL, group_id TEXT, source_message TEXT, category TEXT DEFAULT 'general', is_spam BOOLEAN DEFAULT FALSE, extracted_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS schedules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, status VARCHAR(50) DEFAULT 'active', cron_expr TEXT, ad_library_id UUID, target_groups JSONB DEFAULT '[]', next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, run_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS ad_library (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, message_text TEXT, media_url TEXT, media_type VARCHAR(50), caption TEXT, is_active BOOLEAN DEFAULT TRUE, use_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS campaigns (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, status VARCHAR(50) DEFAULT 'pending', target_groups JSONB DEFAULT '[]', ad_library_id UUID, sent_count INT DEFAULT 0, failed_count INT DEFAULT 0, total_targets INT DEFAULT 0, started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS broadcast_schedules (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT, status VARCHAR(50) DEFAULT 'active', target_groups JSONB DEFAULT '[]', ad_library_id UUID, interval_minutes INT DEFAULT 60, next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS direct_publish_log (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), ad_library_id UUID, target_groups JSONB, sent_count INT DEFAULT 0, failed_count INT DEFAULT 0, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS group_exclusions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone TEXT NOT NULL UNIQUE, reason TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS join_queue (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), link_url TEXT NOT NULL, status VARCHAR(50) DEFAULT 'pending', attempts INT DEFAULT 0, last_attempt_at TIMESTAMPTZ, joined_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS link_search_settings (id INT PRIMARY KEY DEFAULT 1, settings JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS link_join_settings (id INT PRIMARY KEY DEFAULT 1, settings JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS sync_settings (id INT PRIMARY KEY DEFAULT 1, settings JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS account_logs (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), level VARCHAR(20) DEFAULT 'info', message TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS connection_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), status VARCHAR(50), method VARCHAR(50), duration_ms INT, error_message TEXT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS qr_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), attempt_id UUID, event_type VARCHAR(50), latency_ms INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS baileys_events (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), event_type VARCHAR(100), success BOOLEAN DEFAULT TRUE, error_message TEXT, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS diagnostics (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), report JSONB, score INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS business_api_settings (id INT PRIMARY KEY DEFAULT 1, phone_number_id TEXT, access_token TEXT, webhook_verify_token TEXT, settings JSONB DEFAULT '{}', updated_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS pairing_attempts (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), phone TEXT, code TEXT, status VARCHAR(50), latency_ms INT, created_at TIMESTAMPTZ DEFAULT NOW());
CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ DEFAULT NOW());
`;

const DatabaseManager = {
    systemDB: SystemDB,

    async init() {
        await SystemDB.init();
        console.log('[DatabaseManager] Initialized.');
    },

    async getAccountDB(accountId) {
        if (accountDBs.has(accountId)) return accountDBs.get(accountId);

        const schemaName = `acc_${accountId.replace(/-/g, '_')}`;
        const p = getPool();
        const client = await p.connect();
        try {
            await client.query(ACCOUNT_SCHEMA(schemaName));
        } catch (err) {
            console.error(`[DatabaseManager] Schema error for ${accountId}:`, err.message);
        } finally {
            client.release();
        }

        const db = createAccountDB(accountId, schemaName);
        accountDBs.set(accountId, db);
        return db;
    },

    async closeAll() {
        accountDBs.clear();
        await SystemDB.close();
        if (pool) { await pool.end(); pool = null; }
    },
};

module.exports = DatabaseManager;
