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
            console.log(`[Migration] Account ${accountId} — PostgreSQL migrations applied.`);
        } catch (err) {
            console.error(`[Migration] Account ${accountId} error:`, err.message);
        }
    }

    async _migrateExtractedLinks(accountDB) {
        const migrations = [
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS ai_rating  INTEGER DEFAULT 0`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS ai_summary TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS is_spam    BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS category_id TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS country    TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS region     TEXT`,
            `ALTER TABLE extracted_links ADD COLUMN IF NOT EXISTS keywords   TEXT`,
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
}

module.exports = new DatabaseMigrationRunner();
