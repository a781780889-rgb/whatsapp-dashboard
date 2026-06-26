'use strict';
/**
 * Telegram System Migrations
 * إنشاء جداول نظام تيليجرام في قاعدة البيانات
 */

const { query } = require('../../lib/postgres');

const TelegramMigrations = {
    async run() {
        try {
            // ── جدول حسابات تيليجرام ─────────────────────────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS telegram_accounts (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id UUID,
                    name VARCHAR(200) NOT NULL,
                    phone_number VARCHAR(50) NOT NULL,
                    api_id VARCHAR(100),
                    api_hash VARCHAR(200),
                    session_string TEXT,
                    status VARCHAR(50) DEFAULT 'disconnected',
                    last_activity_at TIMESTAMPTZ,
                    links_collected INT DEFAULT 0,
                    channels_monitored INT DEFAULT 0,
                    notes TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            // ── جدول روابط واتساب المكتشفة ──────────────────────────────
            await query(`
                CREATE TABLE IF NOT EXISTS whatsapp_links (
                    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    whatsapp_link TEXT NOT NULL UNIQUE,
                    source_account_id UUID,
                    source_account_name VARCHAR(200),
                    source_group VARCHAR(500),
                    source_channel VARCHAR(500),
                    discovered_at TIMESTAMPTZ DEFAULT NOW(),
                    last_seen TIMESTAMPTZ DEFAULT NOW(),
                    duplicate_count INT DEFAULT 0,
                    status VARCHAR(50) DEFAULT 'new',
                    joined BOOLEAN DEFAULT false,
                    copied BOOLEAN DEFAULT false,
                    deleted BOOLEAN DEFAULT false,
                    notes TEXT,
                    created_at TIMESTAMPTZ DEFAULT NOW(),
                    updated_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            // ── Indexes للأداء ────────────────────────────────────────────
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_status ON whatsapp_links(status)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_discovered ON whatsapp_links(discovered_at DESC)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_account ON whatsapp_links(source_account_id)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_links_deleted ON whatsapp_links(deleted)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_telegram_accounts_user ON telegram_accounts(user_id)`);
            await query(`CREATE INDEX IF NOT EXISTS idx_telegram_accounts_status ON telegram_accounts(status)`);

            console.log('[TelegramMigrations] Tables created successfully');
        } catch (err) {
            // تجاهل أخطاء "already exists"
            if (!err.message?.includes('already exists')) {
                console.error('[TelegramMigrations] Error:', err.message);
            }
        }
    }
};

module.exports = TelegramMigrations;
