'use strict';
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

let pool = null;

function getPool() {
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
            max: 20,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 10000,
        });
        pool.on('error', (err) => console.error('[SystemDB] Pool error:', err.message));
    }
    return pool;
}

const SystemDB = {
    async init() {
        const p = getPool();

        // ── الجداول الأساسية أولاً (بدون foreign keys) ──────────────────────
        await p.query(`
            CREATE TABLE IF NOT EXISTS users (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(100) UNIQUE NOT NULL,
                password TEXT NOT NULL,
                full_name VARCHAR(200),
                email VARCHAR(200),
                role VARCHAR(50) DEFAULT 'user',
                status VARCHAR(50) DEFAULT 'active',
                mfa_enabled BOOLEAN DEFAULT FALSE,
                mfa_secret TEXT,
                failed_login_count INT DEFAULT 0,
                last_failed_login TIMESTAMPTZ,
                locked_until TIMESTAMPTZ,
                last_login TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID,
                name VARCHAR(200) NOT NULL,
                phone_number VARCHAR(50),
                status VARCHAR(50) DEFAULT 'disconnected',
                health_status VARCHAR(50) DEFAULT 'unknown',
                role VARCHAR(50) DEFAULT 'stopped',
                task_status VARCHAR(50) DEFAULT 'idle',
                connection_type VARCHAR(50) DEFAULT 'baileys',
                messages_sent_today INT DEFAULT 0,
                last_activity_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        // ── الجداول التي تعتمد على users ────────────────────────────────────
        await p.query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID UNIQUE NOT NULL,
                plan_type VARCHAR(100) NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                max_accounts INT DEFAULT 1,
                expires_at TIMESTAMPTZ,
                notes TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS subscription_renewals (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                subscription_id UUID,
                plan_type VARCHAR(100),
                extended_hours INT,
                note TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID,
                license_key VARCHAR(100) UNIQUE NOT NULL,
                status VARCHAR(50) DEFAULT 'active',
                plan_type VARCHAR(100),
                issued_by UUID,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS activity_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID,
                username VARCHAR(100),
                action VARCHAR(100),
                details TEXT,
                ip_address VARCHAR(100),
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                username VARCHAR(100),
                ip_address VARCHAR(100),
                success BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS jwt_families (
                family_id VARCHAR(200) PRIMARY KEY,
                user_id UUID,
                revoked BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                token_hash VARCHAR(500) PRIMARY KEY,
                family_id VARCHAR(200),
                user_id UUID,
                used BOOLEAN DEFAULT FALSE,
                expires_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS session_data (
                account_id UUID,
                key TEXT NOT NULL,
                value TEXT,
                updated_at TIMESTAMPTZ DEFAULT NOW(),
                PRIMARY KEY (account_id, key)
            )
        `);

        // [استمرارية النشر المباشر] — يسمح باستئناف جلسات النشر تلقائياً
        // بعد أي إعادة تشغيل لعملية الخادم (Railway restart/redeploy/crash)
        // بدل توقفها بشكل كامل وفقدان التقدم.
        await p.query(`
            CREATE TABLE IF NOT EXISTS live_publish_sessions (
                id UUID PRIMARY KEY,
                status VARCHAR(20) NOT NULL DEFAULT 'running',
                cfg JSONB NOT NULL,
                cursor JSONB DEFAULT '{}',
                stats JSONB DEFAULT '{}',
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_live_publish_status ON live_publish_sessions(status)`).catch(() => {});

        // ── Keyword Monitoring Tables ─────────────────────────────────────
        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_keywords (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                word TEXT NOT NULL,
                category TEXT DEFAULT 'عام',
                priority VARCHAR(20) DEFAULT 'normal',
                color VARCHAR(20) DEFAULT '#00A884',
                case_sensitive BOOLEAN DEFAULT FALSE,
                is_active BOOLEAN DEFAULT TRUE,
                match_count INT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_keywords_user ON kw_keywords(user_id)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_alerts (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                keyword_id UUID,
                matched_keyword TEXT NOT NULL,
                message_text TEXT,
                sender_name TEXT,
                sender_phone TEXT,
                group_name TEXT,
                group_jid TEXT,
                account_id UUID,
                message_time TIMESTAMPTZ DEFAULT NOW(),
                status VARCHAR(30) DEFAULT 'new',
                internal_note TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_alerts_user ON kw_alerts(user_id, message_time DESC)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_alerts_status ON kw_alerts(user_id, status)`).catch(() => {});

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_settings (
                user_id UUID PRIMARY KEY,
                settings JSONB DEFAULT '{}',
                updated_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS kw_activity_log (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id UUID NOT NULL,
                action VARCHAR(100),
                details TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW()
            )
        `);
        await p.query(`CREATE INDEX IF NOT EXISTS idx_kw_activity_user ON kw_activity_log(user_id, created_at DESC)`).catch(() => {});

        // ── Telegram System Tables ────────────────────────────────────────
        const TelegramMigrations = require('./TelegramMigrations');
        await TelegramMigrations.run();

        // ── Indexes for Multi-Tenant Performance ──────────────────────────────
        await p.query(`CREATE INDEX IF NOT EXISTS idx_accounts_user_id ON accounts(user_id)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON subscriptions(status, expires_at)`).catch(() => {});
        // Migrate existing subscriptions table if UNIQUE constraint missing
        await p.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = 'subscriptions_user_id_key'
                ) THEN
                    -- Remove duplicate subscriptions, keep latest per user
                    DELETE FROM subscriptions s1
                    USING subscriptions s2
                    WHERE s1.user_id = s2.user_id AND s1.created_at < s2.created_at;
                    -- Add unique constraint
                    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_user_id_key UNIQUE (user_id);
                END IF;
            END $$;
        `).catch(() => {});

        // ── Migration: إضافة حقل enable_telegram لجدول subscriptions ────────
        await p.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name='subscriptions' AND column_name='enable_telegram'
                ) THEN
                    ALTER TABLE subscriptions ADD COLUMN enable_telegram BOOLEAN DEFAULT FALSE;
                END IF;
            END $$;
        `).catch(() => {});

        // ── [إصلاح تسجيل الدخول] Migration: استكمال أعمدة جدول refresh_tokens —
        //    جدول refresh_tokens في قاعدة بيانات الإنتاج قديم جداً (أُنشئ قبل
        //    اكتمال ميزة "تتبّع عائلة التوكنات" / اكتشاف إعادة الاستخدام)،
        //    و`CREATE TABLE IF NOT EXISTS` لا يضيف أعمدة جديدة لجدول موجود
        //    مسبقاً. النتيجة: كانت الأعمدة الناقصة تظهر واحداً تلو الآخر مع كل
        //    محاولة تسجيل دخول ("family_id" ثم "used" ...) بدل أن يُكتشف
        //    النقص دفعة واحدة. الآن نتأكد من وجود كل عمود يعتمد عليه
        //    saveRefreshToken/findRefreshToken/revoke* في نفس الاستدعاء،
        //    باستخدام `ADD COLUMN IF NOT EXISTS` (مدعومة في PostgreSQL) بدل
        //    فحص information_schema لكل عمود على حدة.
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id VARCHAR(200)`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_id UUID`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used BOOLEAN DEFAULT FALSE`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});
        await p.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family_id ON refresh_tokens(family_id)`).catch(() => {});
        await p.query(`CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id)`).catch(() => {});

        console.log('[SystemDB] Schema initialized.');
    },

    async query(sql, params = []) {
        const p = getPool();
        return await p.query(sql, params);
    },

    async get(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows[0] || null;
    },

    async all(sql, params = []) {
        const result = await this.query(sql, params);
        return result.rows;
    },

    async run(sql, params = []) {
        const result = await this.query(sql, params);
        return { rowCount: result.rowCount };
    },

    async seedSuperAdmin() {
        const existing = await this.get(`SELECT id FROM users WHERE role = 'super_admin' LIMIT 1`);
        if (existing) return;

        const password = process.env.ADMIN_PASSWORD || 'Admin@123456';
        const hash = await bcrypt.hash(password, 12);
        const username = process.env.ADMIN_USERNAME || 'admin';

        await this.run(
            `INSERT INTO users (id, username, password, full_name, role, status)
             VALUES ($1, $2, $3, $4, 'super_admin', 'active')
             ON CONFLICT (username) DO NOTHING`,
            [uuidv4(), username, hash, 'Super Admin']
        );
        console.log(`[SystemDB] Super admin seeded: ${username}`);
    },

    async log(userId, username, action, details, ip = null) {
        await this.run(
            `INSERT INTO activity_logs (id, user_id, username, action, details, ip_address)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [uuidv4(), userId || null, username || null, action, details || null, ip || null]
        ).catch(() => {});
    },

    async recordAttempt(username, ip, success) {
        await this.run(
            `INSERT INTO login_attempts (id, username, ip_address, success) VALUES ($1, $2, $3, $4)`,
            [uuidv4(), username, ip, success]
        ).catch(() => {});
    },

    async isBlocked(username) {
        return await this.get(
            `SELECT locked_until FROM users WHERE username=$1 AND locked_until > NOW()`, [username]
        ).catch(() => null);
    },

    async close() {
        if (pool) { await pool.end(); pool = null; }
    }
};

module.exports = SystemDB;

// ── دوال إضافية مطلوبة من AuthController ────────────────────────────────────

Object.assign(SystemDB, {

    async getActiveSubscription(userId) {
        return await this.get(
            `SELECT * FROM subscriptions
             WHERE user_id = $1 AND status = 'active'
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY created_at DESC LIMIT 1`,
            [userId]
        ).catch(() => null);
    },

    async getDaysRemaining(sub) {
        if (!sub || !sub.expires_at) return 9999;
        const ms = new Date(sub.expires_at) - Date.now();
        return Math.max(0, Math.ceil(ms / 86400000));
    },

    // [FIX-AUTH-REUSE] كان هذا الاستدعاء يبتلع أي خطأ كتابة بصمت (.catch(()=>{}))
    // — فلو فشل الإدراج لأي سبب (تحميل مؤقت على DB، إعادة تشغيل الخادم أثناء
    // الكتابة...)، يبقى الـ refresh token صالحاً تشفيرياً (JWT موقّع بنجاح)
    // لكن بلا أي صف مطابق في قاعدة البيانات. أول محاولة refresh حقيقية بهذا
    // التوكن كانت تُفسَّر خطأً على أنها "إعادة استخدام" (لأن findRefreshToken
    // ترجع null)، فيُعتبر الـ family كله "مخترقاً" وتُبطَل الجلسة بالكامل رغم
    // أنه أول استخدام فعلي — بالضبط ما ظهر في سجلات النشر: "[Auth] REUSE
    // DETECTED" فور تسجيل الدخول رغم عدم وجود أي سرقة حقيقية. الآن الخطأ
    // يُرفع للأعلى ليتعامل معه المستدعي (issue/refresh) صراحة بدل الفشل الصامت.
    async saveRefreshToken(userId, tokenHash, ip, userAgent, expiresAt, familyId) {
        await this.run(
            `INSERT INTO refresh_tokens (token_hash, family_id, user_id, used, expires_at)
             VALUES ($1, $2, $3, FALSE, $4)
             ON CONFLICT (token_hash) DO NOTHING`,
            [tokenHash, familyId || null, userId, expiresAt]
        );
    },

    // [FIX-AUTH-REUSE] يُرجع الصف فقط إن كان لا يزال غير مُستخدَم (used=FALSE)
    // وغير منتهي الصلاحية — هذا هو الفحص الصحيح لتمييز "توكن صالح للاستخدام"
    // عن "توكن مُستخدَم سابقاً/منتهي"، بدل الاعتماد فقط على وجود الصف (كان
    // أي صف موجود يُعتبر صالحاً حتى لو used=TRUE بالفعل، مما يسمح نظرياً
    // بإعادة استخدام توكن مُدار بالفعل بدل رفضه واعتباره اختراقاً محتملاً).
    async findRefreshToken(tokenHash) {
        return await this.get(
            `SELECT * FROM refresh_tokens WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()`,
            [tokenHash]
        ).catch(() => null);
    },

    async revokeRefreshToken(tokenHash) {
        await this.run(
            `UPDATE refresh_tokens SET used = TRUE WHERE token_hash = $1`, [tokenHash]
        ).catch(() => {});
    },

    async revokeAllUserTokensByFamily(familyId) {
        await this.run(
            `UPDATE refresh_tokens SET used = TRUE WHERE family_id = $1`, [familyId]
        ).catch(() => {});
    },

    async revokeAllUserTokens(userId) {
        await this.run(
            `UPDATE refresh_tokens SET used = TRUE WHERE user_id = $1`, [userId]
        ).catch(() => {});
    },
});

// ── deleteAllSessionData ────────────────────────────────────────────
Object.assign(SystemDB, {
    async deleteAllSessionData(accountId) {
        await this.run(
            `DELETE FROM session_data WHERE account_id = $1`, [accountId]
        ).catch(() => {});
    },
});
