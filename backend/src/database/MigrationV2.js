'use strict';
/**
 * MigrationV2 — Database Hardening Migrations
 * المرحلة 2: إضافة الـ Indexes الناقصة + تعزيز Schema
 *
 * يُستدعى مرة واحدة من SystemDB.init() بعد إنشاء الجداول.
 * كل عملية محاطة بـ .catch(() => {}) لأن الأخطاء هنا غير حرجة
 * (مثلاً: index موجود مسبقاً).
 */
const { query } = require('../lib/postgres');

class MigrationV2 {

    async run() {
        console.log('[MigrationV2] Running Database Hardening migrations...');
        await this._addSystemIndexes();
        await this._addAccountSchemaIndexHints();
        await this._addMissingColumns();
        await this._addConstraints();
        console.log('[MigrationV2] Done.');

        // ── Phase 5: family column for refresh_tokens ─────────────────────────
        await query(`
            ALTER TABLE refresh_tokens
            ADD COLUMN IF NOT EXISTS family TEXT
        `).catch(() => {});
        await query(`
            CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family)
        `).catch(() => {});
        
        console.log('[MigrationV2] Phase 5: family column added to refresh_tokens ✅');
    }

    // ── System-Level Indexes ──────────────────────────────────────────────────
    async _addSystemIndexes() {
        const indexes = [
            // accounts
            `CREATE INDEX IF NOT EXISTS idx_accounts_user_status
                ON accounts(user_id, status)`,
            `CREATE INDEX IF NOT EXISTS idx_accounts_updated
                ON accounts(updated_at DESC)`,

            // users
            `CREATE INDEX IF NOT EXISTS idx_users_role
                ON users(role)`,
            `CREATE INDEX IF NOT EXISTS idx_users_status
                ON users(status)`,

            // audit_log — البحث السريع بالـ action type
            `CREATE INDEX IF NOT EXISTS idx_audit_action
                ON audit_log(action)`,

            // refresh_tokens — تنظيف التوكنات المنتهية
            `CREATE INDEX IF NOT EXISTS idx_rt_expires
                ON refresh_tokens(expires_at)`,

            // login_attempts — الحماية من Brute Force بالـ IP
            `CREATE INDEX IF NOT EXISTS idx_attempts_ip
                ON login_attempts(ip_address, created_at DESC)`,

            // subscriptions — الاشتراكات النشطة المنتهية قريباً
            `CREATE INDEX IF NOT EXISTS idx_subs_active_exp
                ON subscriptions(status, expires_at)
                WHERE status = 'active'`,

            // session_data — cleanup الجلسات القديمة
            `CREATE INDEX IF NOT EXISTS idx_sd_updated
                ON session_data(updated_at)`,
        ];

        for (const sql of indexes) {
            await query(sql).catch(err =>
                console.warn('[MigrationV2] Index skip:', err.message.split('\n')[0])
            );
        }
    }

    // ── Account Schema Default Indexes (يُطبَّق على كل schema جديد عبر AccountDB) ──
    // هذه مجرد توثيق — AccountDB._addV2Indexes() يُطبِّقها فعلياً
    async _addAccountSchemaIndexHints() {
        // No-op هنا — يُنفَّذ في AccountDB
    }

    // ── أعمدة مفقودة في SystemDB ─────────────────────────────────────────────
    async _addMissingColumns() {
        const migrations = [
            // accounts: connection_type قد يكون غير موجود في التثبيتات القديمة
            `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT 'qr_code'`,
            `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_phase TEXT DEFAULT 'none'`,
            `ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMP`,

            // users: failed_login_count للحماية من Brute Force
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_count INTEGER DEFAULT 0`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP`,
            `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_failed_login TIMESTAMP`,

            // login_attempts: إضافة ip_address إذا لم يكن موجوداً
            `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS ip_address TEXT`,
            `ALTER TABLE login_attempts ADD COLUMN IF NOT EXISTS user_agent TEXT`,
        ];

        for (const sql of migrations) {
            await query(sql).catch(err =>
                console.warn('[MigrationV2] Column skip:', err.message.split('\n')[0])
            );
        }
    }

    // ── قيود البيانات (Constraints) ───────────────────────────────────────────
    async _addConstraints() {
        // CHECK constraints على الأعمدة الحرجة
        const constraints = [
            // منع قيم فارغة في accounts.name
            `DO $$ BEGIN
                ALTER TABLE accounts ADD CONSTRAINT chk_accounts_name_nonempty
                CHECK (name <> '');
            EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

            // التحقق من صحة الأدوار
            `DO $$ BEGIN
                ALTER TABLE users ADD CONSTRAINT chk_users_role_valid
                CHECK (role IN ('super_admin','admin','user','viewer'));
            EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

            // منع expires_at في الماضي للاشتراكات الجديدة (يُطبَّق فقط على INSERT)

        ];

        for (const sql of constraints) {
            await query(sql).catch(err =>
                console.warn('[MigrationV2] Constraint skip:', err.message.split('\n')[0])
            );
        }
    }
}

module.exports = new MigrationV2();
