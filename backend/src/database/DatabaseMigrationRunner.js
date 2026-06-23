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
                        await accountDB.run(migration.sql);
                        await accountDB.run(
                            `INSERT INTO schema_migrations (version, name) VALUES ($1, $2)`,
                            [migration.version, migration.name]
                        );
                    } catch (err) {
                        // تجاهل أخطاء ALTER TABLE (عمود موجود مسبقاً)
                        if (!err.message?.includes('already exists')) {
                            console.warn(`[Migration] v${migration.version} warning:`, err.message);
                        }
                    }
                }
            }
        } catch (err) {
            console.warn(`[Migration] Non-critical error for ${accountId}:`, err.message);
        }
    }
};

module.exports = MigrationRunner;
