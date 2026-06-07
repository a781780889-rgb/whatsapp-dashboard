'use strict';
/**
 * DatabaseBackupJob — PostgreSQL pg_dump backup
 * Section 10.3 Phase 1 من وثيقة التحليل:
 * الآن يعمل مع PostgreSQL بدلاً من SQLite.
 * يستخدم pg_dump (إن كان متاحاً) أو يُسجّل تذكيراً بالنسخ الاحتياطية
 * عبر Railway/Neon المدارة.
 */
const { exec } = require('child_process');
const fs   = require('fs');
const path = require('path');

const BACKUP_DIR  = path.resolve(__dirname, '../../../backups');
const MAX_BACKUPS = 7;

class DatabaseBackupJob {
    constructor() {
        this.intervalId = null;
    }

    start(intervalHours = 24) {
        const ms = intervalHours * 60 * 60 * 1000;
        setTimeout(() => this.run(), 60000); // Run after 1 min on startup
        this.intervalId = setInterval(() => this.run(), ms);
        console.log(`[Backup] PostgreSQL Backup Job started — every ${intervalHours}h.`);
    }

    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    async run() {
        try {
            const dbUrl = process.env.DATABASE_URL;
            if (!dbUrl) {
                console.warn('[Backup] DATABASE_URL not set — skipping backup.');
                return;
            }

            // If DATABASE_URL points to a managed service (Neon, Supabase, Railway PG),
            // those services handle backups automatically. We just log a confirmation.
            const isManaged = dbUrl.includes('neon.tech')
                           || dbUrl.includes('supabase.co')
                           || dbUrl.includes('railway.app');

            if (isManaged) {
                console.log('[Backup] ✅ Managed PostgreSQL detected — backup handled by provider automatically.');
                return;
            }

            // For self-hosted PostgreSQL: attempt pg_dump
            fs.mkdirSync(BACKUP_DIR, { recursive: true });
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const outFile   = path.join(BACKUP_DIR, `backup_${timestamp}.sql`);

            await new Promise((resolve, reject) => {
                exec(`pg_dump "${dbUrl}" -f "${outFile}" --no-password`, (err, stdout, stderr) => {
                    if (err) {
                        console.warn('[Backup] pg_dump not available or failed:', stderr || err.message);
                        console.warn('[Backup] ℹ Ensure your PostgreSQL provider has automated backups enabled.');
                        resolve(); // Non-fatal
                    } else {
                        console.log(`[Backup] ✅ PostgreSQL dump saved to ${outFile}`);
                        resolve();
                    }
                });
            });

            this._pruneOldBackups();
        } catch (err) {
            console.error('[Backup] ❌ Backup error:', err.message);
        }
    }

    _pruneOldBackups() {
        if (!fs.existsSync(BACKUP_DIR)) return;
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.startsWith('backup_'))
            .map(f => ({ name: f, time: fs.statSync(path.join(BACKUP_DIR, f)).mtimeMs }))
            .sort((a, b) => b.time - a.time);

        for (const file of files.slice(MAX_BACKUPS)) {
            fs.rmSync(path.join(BACKUP_DIR, file.name), { recursive: true, force: true });
            console.log(`[Backup] 🗑 Removed old backup: ${file.name}`);
        }
    }
}

module.exports = new DatabaseBackupJob();
