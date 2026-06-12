'use strict';
/**
 * DatabaseMigrationRunner — PostgreSQL Edition
 * يُطبق ALTER TABLE migrations بأمان عبر information_schema.
 * PostgreSQL يدعم ADD COLUMN IF NOT EXISTS مباشرة (PG 9.6+).
 */

class DatabaseMigrationRunner {
    async run(accountId, accountDB) {
        try {
            await this._migrateExtractedLinks(accountDB);
            await this._migrateCampaigns(accountDB);
            await this._migrateAccounts(accountDB);
            await this._migrateWaGroups(accountDB);
            await this._migrateAutoJoinSettings(accountDB); // ← الجزء الثالث
            console.log(`[Migration] Account ${accountId} — PostgreSQL migrations applied.`);
        } catch (err) {
            console.error(`[Migration] Account ${accountId} error:`, err.message);
        }
    }

    async _migrateExtractedLinks(accountDB) {
        const migrations = [
            // الأعمدة القديمة
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS ai_rating              INTEGER DEFAULT 0`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS ai_summary             TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS is_spam                BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS category_id            TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS country                TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS region                 TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS keywords               TEXT`,
            // الجزء الثالث — أعمدة جديدة
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS link_type              TEXT DEFAULT 'other'`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS invite_code            TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS discovered_by_account_id TEXT`,
        ];
        for (const sql of migrations) {
            await accountDB.run(sql).catch(() => {}); // Silently skip if column exists
        }
    }

    async _migrateCampaigns(accountDB) {
        const migrations = [
            `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ad_library_id    TEXT`,
            `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS target_type      TEXT DEFAULT 'lists'`,
            `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS batch_size       INTEGER DEFAULT 50`,
            `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS interval_seconds INTEGER DEFAULT 10`,
            `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS daily_limit      INTEGER DEFAULT 1000`,
        ];
        for (const sql of migrations) {
            await accountDB.run(sql).catch(() => {});
        }
    }

    async _migrateAccounts(accountDB) {
        // Future account-level migrations go here
    }

    // ── مجموعات واتساب الحقيقية ──────────────────────────────────────────────
    async _migrateWaGroups(accountDB) {
        // 1. إنشاء الجدول إذا لم يكن موجوداً (للتثبيتات الجديدة)
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS wa_groups (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                group_jid       TEXT UNIQUE NOT NULL,
                name            TEXT DEFAULT '',
                description     TEXT DEFAULT '',
                owner           TEXT DEFAULT '',
                members_count   INTEGER DEFAULT 0,
                admins_count    INTEGER DEFAULT 0,
                announce        BOOLEAN DEFAULT FALSE,
                restrict_mode   BOOLEAN DEFAULT FALSE,
                creation_ts     BIGINT  DEFAULT 0,
                avatar_url      TEXT,
                is_member       BOOLEAN DEFAULT TRUE,
                is_admin        BOOLEAN DEFAULT FALSE,
                publish_status  TEXT DEFAULT 'green',
                can_send_text   BOOLEAN DEFAULT TRUE,
                can_send_images BOOLEAN DEFAULT TRUE,
                can_send_video  BOOLEAN DEFAULT TRUE,
                can_send_files  BOOLEAN DEFAULT TRUE,
                can_send_links  BOOLEAN DEFAULT TRUE,
                can_broadcast   BOOLEAN DEFAULT FALSE,
                activity_level  INTEGER DEFAULT 50,
                messages_today  INTEGER DEFAULT 0,
                last_sync       TIMESTAMP DEFAULT NOW(),
                created_at      TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});

        // 2. إضافة الأعمدة الناقصة للتثبيتات القديمة (groups القديمة)
        const migrations = [
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS group_jid       TEXT`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS description     TEXT DEFAULT ''`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS owner           TEXT DEFAULT ''`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS members_count   INTEGER DEFAULT 0`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS admins_count    INTEGER DEFAULT 0`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS announce        BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS restrict_mode   BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS creation_ts     BIGINT  DEFAULT 0`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS avatar_url      TEXT`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS is_member       BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS is_admin        BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS publish_status  TEXT DEFAULT 'green'`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS can_send_text   BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS can_send_images BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS can_send_video  BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS can_send_files  BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS can_send_links  BOOLEAN DEFAULT TRUE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS can_broadcast   BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS activity_level  INTEGER DEFAULT 50`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS messages_today  INTEGER DEFAULT 0`,
            `ALTER TABLE wa_groups ADD COLUMN IF NOT EXISTS last_sync       TIMESTAMP DEFAULT NOW()`,
        ];
        for (const sql of migrations) {
            await accountDB.run(sql).catch(() => {});
        }

        // 3. إنشاء index للأداء
        await accountDB.run(
            `CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_groups_jid ON wa_groups(group_jid)`
        ).catch(() => {});
    }

    // ── الجزء الثالث: إعدادات الانضمام التلقائي ──────────────────────────────
    async _migrateAutoJoinSettings(accountDB) {
        const migrations = [
            // أعمدة إعدادات الانضمام الجديدة
            `ALTER TABLE auto_join_settings ADD COLUMN IF NOT EXISTS join_mode              TEXT DEFAULT 'immediate'`,
            `ALTER TABLE auto_join_settings ADD COLUMN IF NOT EXISTS join_delay_seconds     INTEGER DEFAULT 30`,
            `ALTER TABLE auto_join_settings ADD COLUMN IF NOT EXISTS distribution_mode      TEXT DEFAULT 'single'`,

            // أعمدة طابور الانضمام الجديدة
            `ALTER TABLE auto_join_queue ADD COLUMN IF NOT EXISTS join_mode          TEXT DEFAULT 'immediate'`,
            `ALTER TABLE auto_join_queue ADD COLUMN IF NOT EXISTS delay_seconds      INTEGER DEFAULT 0`,
            `ALTER TABLE auto_join_queue ADD COLUMN IF NOT EXISTS distribution_mode  TEXT DEFAULT 'single'`,
            `ALTER TABLE auto_join_queue ADD COLUMN IF NOT EXISTS result_group_id    TEXT`,
            `ALTER TABLE auto_join_queue ADD COLUMN IF NOT EXISTS error_msg         TEXT`,

            // Index للأداء
            `CREATE INDEX IF NOT EXISTS idx_auto_join_queue_status ON auto_join_queue(status)`,
            `CREATE INDEX IF NOT EXISTS idx_extracted_links_link_type ON extracted_links(link_type)`,
        ];
        for (const sql of migrations) {
            await accountDB.run(sql).catch(() => {});
        }
    }
}

module.exports = new DatabaseMigrationRunner();
