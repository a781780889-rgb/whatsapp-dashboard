'use strict';
/**
 * DatabaseMigrationRunner — تطبيق migrations على account schemas
 */

const migrations = [
    {
        version: 1,
        name: 'add_connection_type_to_accounts',
        sql: `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS connection_type VARCHAR(50) DEFAULT 'baileys'`
    },
    {
        version: 2,
        name: 'add_health_status_to_accounts',
        sql: `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS health_status VARCHAR(50) DEFAULT 'unknown'`
    },
    {
        version: 3,
        name: 'upgrade_ad_library_schema_v1',
        sql: `
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS content TEXT DEFAULT '';
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS media_paths JSONB DEFAULT '[]';
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS media_types JSONB DEFAULT '[]';
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS links JSONB DEFAULT '[]';
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS format_options JSONB DEFAULT '{}';
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS priority INT DEFAULT 5;
            ALTER TABLE ad_library ADD COLUMN IF NOT EXISTS tags TEXT DEFAULT '';
        `
    },
    {
        version: 4,
        name: 'migrate_ad_library_message_text_to_content',
        sql: `UPDATE ad_library SET content = COALESCE(message_text, '') WHERE content IS NULL OR content = ''`
    },
];

const MigrationRunner = {
    async run(accountId, accountDB) {
        try {
            // إنشاء جدول الـ migrations إذا لم يكن موجوداً
            await accountDB.run(`
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version INT PRIMARY KEY,
                    name TEXT,
                    applied_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            const applied = await accountDB.all(`SELECT version FROM schema_migrations`);
            const appliedVersions = new Set(applied.map(r => r.version));

            for (const migration of migrations) {
                if (!appliedVersions.has(migration.version)) {
                    try {
                        // تنفيذ كل statement على حدة إذا كانت متعددة
                        const statements = migration.sql.split(';').map(s => s.trim()).filter(Boolean);
                        for (const stmt of statements) {
                            await accountDB.run(stmt);
                        }
                        await accountDB.run(
                            `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
                            [migration.version, migration.name]
                        );
                        console.log(`[Migration] Applied v${migration.version}: ${migration.name}`);
                    } catch (err) {
                        // تجاهل أخطاء ALTER TABLE (عمود موجود مسبقاً)
                        if (!err.message?.includes('already exists')) {
                            console.warn(`[Migration] v${migration.version} warning:`, err.message);
                        }
                        // سجّل المهاجرة كمكتملة حتى لا تُعاد
                        try {
                            await accountDB.run(
                                `INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                                [migration.version, migration.name]
                            );
                        } catch (_) {}
                    }
                }
            }
        } catch (err) {
            console.warn(`[Migration] Non-critical error for ${accountId}:`, err.message);
        }
    }
};

module.exports = MigrationRunner;
