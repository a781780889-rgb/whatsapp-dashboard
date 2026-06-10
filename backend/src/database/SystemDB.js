'use strict';
/**
 * SystemDB — PostgreSQL System-Level Database Singleton
 * النسخة المحدّثة: نظام الاشتراكات الاحترافي الكامل
 *
 * الجداول المُدارة:
 *   - accounts              : حسابات واتساب
 *   - users                 : مستخدمو اللوحة
 *   - subscriptions         : الاشتراكات (مع حقول إضافية)
 *   - subscription_renewals : سجل تجديدات الاشتراكات
 *   - subscription_notifications: إشعارات التجديد
 *   - licenses              : التراخيص
 *   - audit_log             : سجل العمليات
 *   - login_attempts        : محاولات تسجيل الدخول
 *   - refresh_tokens        : رموز التحديث
 *   - session_data          : بيانات جلسات واتساب
 */
const { query, queryOne, queryAll } = require('../lib/postgres');
const bcrypt  = require('bcryptjs');
const crypto  = require('crypto');

class SystemDB {

    async init() {
        // ── Core Tables ───────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id                  TEXT PRIMARY KEY,
                user_id             TEXT,
                phone_number        TEXT,
                name                TEXT NOT NULL,
                status              TEXT DEFAULT 'disconnected',
                health_status       TEXT DEFAULT 'unknown',
                role                TEXT DEFAULT 'stopped',
                task_status         TEXT DEFAULT 'idle',
                messages_sent_today INTEGER DEFAULT 0,
                last_activity_at    TIMESTAMP,
                created_at          TIMESTAMP DEFAULT NOW(),
                updated_at          TIMESTAMP DEFAULT NOW()
            )
        `);

        await query(`
            CREATE TABLE IF NOT EXISTS users (
                id          TEXT PRIMARY KEY,
                username    TEXT UNIQUE NOT NULL,
                password    TEXT NOT NULL,
                full_name   TEXT,
                email       TEXT,
                role        TEXT DEFAULT 'user',
                status      TEXT DEFAULT 'active',
                mfa_enabled BOOLEAN DEFAULT FALSE,
                mfa_secret  TEXT,
                last_login  TIMESTAMP,
                created_at  TIMESTAMP DEFAULT NOW(),
                updated_at  TIMESTAMP DEFAULT NOW()
            )
        `);

        // ── Subscriptions ─────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS subscriptions (
                id             TEXT PRIMARY KEY,
                user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                plan_type      TEXT DEFAULT 'basic',
                started_at     TIMESTAMP DEFAULT NOW(),
                expires_at     TIMESTAMP,
                status         TEXT DEFAULT 'active',
                note           TEXT DEFAULT '',
                frozen_at      TIMESTAMP,
                frozen_until   TIMESTAMP,
                auto_renew     BOOLEAN DEFAULT FALSE,
                created_by     TEXT,
                created_at     TIMESTAMP DEFAULT NOW(),
                updated_at     TIMESTAMP DEFAULT NOW()
            )
        `);

        // ترقية الجدول القديم إذا كانت الأعمدة الجديدة غير موجودة
        const subsUpgrades = [
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS started_at TIMESTAMP DEFAULT NOW()`,
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''`,
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS frozen_at TIMESTAMP`,
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS frozen_until TIMESTAMP`,
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN DEFAULT FALSE`,
            `ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW()`,
        ];
        for (const sql of subsUpgrades) {
            await query(sql).catch(() => {});
        }

        await query(`CREATE INDEX IF NOT EXISTS idx_subs_user   ON subscriptions(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_subs_status ON subscriptions(status)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_subs_exp    ON subscriptions(expires_at)`);

        // ── Subscription Renewals (سجل التجديدات) ────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS subscription_renewals (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                user_id         TEXT NOT NULL,
                old_plan_type   TEXT,
                new_plan_type   TEXT NOT NULL,
                old_expires_at  TIMESTAMP,
                new_expires_at  TIMESTAMP,
                extended_hours  INTEGER DEFAULT 0,
                action_by       TEXT,
                note            TEXT,
                created_at      TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_renewals_sub  ON subscription_renewals(subscription_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_renewals_user ON subscription_renewals(user_id)`);

        // ── Subscription Notifications (إشعارات التجديد) ─────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS subscription_notifications (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                user_id         TEXT NOT NULL,
                type            TEXT NOT NULL,  -- 'reminder_7d', 'reminder_3d', 'reminder_1d', 'expired'
                sent_at         TIMESTAMP DEFAULT NOW(),
                UNIQUE(subscription_id, type)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_notif_sub ON subscription_notifications(subscription_id)`);

        // ── Licenses ──────────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS licenses (
                id          TEXT PRIMARY KEY,
                user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                license_key TEXT UNIQUE NOT NULL,
                status      TEXT DEFAULT 'active',
                issued_by   TEXT,
                note        TEXT,
                created_at  TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_lic_user ON licenses(user_id)`);

        // ── Audit Log ─────────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                user_id    TEXT,
                username   TEXT,
                action     TEXT,
                details    TEXT,
                ip         TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`);

        // ── Login Attempts ────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS login_attempts (
                id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                username   TEXT NOT NULL,
                ip         TEXT,
                success    BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_attempts_user ON login_attempts(username, created_at DESC)`);

        // ── Refresh Tokens ────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS refresh_tokens (
                id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                user_id     TEXT NOT NULL,
                token_hash  TEXT UNIQUE NOT NULL,
                ip          TEXT,
                user_agent  TEXT,
                expires_at  TIMESTAMP NOT NULL,
                revoked     BOOLEAN DEFAULT FALSE,
                created_at  TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash)`);

        // ── Session Data ──────────────────────────────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS session_data (
                account_id TEXT NOT NULL,
                key        TEXT NOT NULL,
                value      TEXT,
                updated_at TIMESTAMP DEFAULT NOW(),
                PRIMARY KEY (account_id, key)
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_sd_account ON session_data(account_id)`);

        console.log('[SystemDB] ✅ جميع الجداول جاهزة (PostgreSQL).');
    }

    async seedSuperAdmin() {
        const existing = await queryOne(`SELECT id FROM users WHERE role IN ('superadmin','owner') LIMIT 1`);
        if (existing) return;
        const adminUser = process.env.ADMIN_USERNAME || 'admin';
        const adminPass = process.env.ADMIN_PASSWORD || 'Admin@123456';
        const hash      = await bcrypt.hash(adminPass, 12);
        const id        = crypto.randomUUID();
        await query(
            `INSERT INTO users (id, username, password, full_name, role, status)
             VALUES ($1, $2, $3, $4, 'superadmin', 'active')
             ON CONFLICT (username) DO NOTHING`,
            [id, adminUser, hash, 'Super Administrator']
        );
        // إضافة اشتراك دائم تلقائياً للمدير الرئيسي
        await query(
            `INSERT INTO subscriptions (id, user_id, plan_type, expires_at, status, note, created_by)
             VALUES ($1, $2, 'lifetime', NULL, 'active', 'اشتراك دائم - المالك', $2)
             ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), id]
        ).catch(() => {});
        console.log(`[SystemDB] ✅ تم إنشاء المدير الرئيسي: ${adminUser}`);
    }

    // ── Generic Helpers ───────────────────────────────────────────────────────
    async get(sql, params = []) { return queryOne(sql, params); }
    async all(sql, params = []) { return queryAll(sql, params); }
    async run(sql, params = []) { return query(sql, params); }

    // ── Audit Log ─────────────────────────────────────────────────────────────
    async log(userId, username, action, details = '', ip = null) {
        try {
            await query(
                `INSERT INTO audit_log (id, user_id, username, action, details, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
                [crypto.randomUUID(), userId || null, username || null, action, details, ip]
            );
        } catch (err) { console.error('[SystemDB] Audit log error:', err.message); }
    }

    // ── Login Attempts ────────────────────────────────────────────────────────
    async recordAttempt(username, ip, success) {
        await query(
            `INSERT INTO login_attempts (id, username, ip, success) VALUES ($1,$2,$3,$4)`,
            [crypto.randomUUID(), username, ip, success]
        );
    }

    async isBlocked(username) {
        const row = await queryOne(
            `SELECT COUNT(*) as cnt FROM login_attempts
             WHERE username=$1 AND success=FALSE AND created_at > NOW() - INTERVAL '15 minutes'`,
            [username]
        );
        const cnt = parseInt(row?.cnt || 0, 10);
        if (cnt < 10) return null;
        const blockedUntil = new Date(Date.now() + 15 * 60 * 1000);
        return { blocked_until: blockedUntil.toISOString(), attempts: cnt };
    }

    // ── Subscription Methods ──────────────────────────────────────────────────

    /** جلب الاشتراك النشط للمستخدم */
    async getActiveSubscription(userId) {
        return queryOne(
            `SELECT * FROM subscriptions
             WHERE user_id=$1
               AND status='active'
               AND (expires_at IS NULL OR expires_at > NOW())
             ORDER BY expires_at DESC NULLS FIRST LIMIT 1`,
            [userId]
        );
    }

    /** حساب الأيام المتبقية */
    async getDaysRemaining(sub) {
        if (!sub || !sub.expires_at) return null;
        const ms = new Date(sub.expires_at) - Date.now();
        return Math.max(0, Math.ceil(ms / 86400000));
    }

    /** تمديد الاشتراك بعدد ساعات إضافية */
    async extendSubscription(subId, extraHours, adminId, adminUsername, note = '', ip = null) {
        const sub = await queryOne(`SELECT * FROM subscriptions WHERE id=$1`, [subId]);
        if (!sub) throw new Error('الاشتراك غير موجود');

        const base = sub.expires_at ? new Date(sub.expires_at) : new Date();
        const newExpiry = new Date(base.getTime() + extraHours * 3600000);

        await query(
            `UPDATE subscriptions SET expires_at=$1, status='active', updated_at=NOW() WHERE id=$2`,
            [newExpiry.toISOString(), subId]
        );

        // تسجيل في سجل التجديدات
        await query(
            `INSERT INTO subscription_renewals
             (subscription_id, user_id, old_plan_type, new_plan_type, old_expires_at, new_expires_at, extended_hours, action_by, note)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [subId, sub.user_id, sub.plan_type, sub.plan_type,
             sub.expires_at, newExpiry.toISOString(), extraHours, adminId, note]
        );

        await this.log(adminId, adminUsername, 'SUBSCRIPTION_EXTENDED',
            `تمديد ${extraHours} ساعة — ID: ${subId}`, ip);

        return newExpiry;
    }

    /** تجميد الاشتراك */
    async freezeSubscription(subId, adminId, adminUsername, note = '', ip = null) {
        const sub = await queryOne(`SELECT * FROM subscriptions WHERE id=$1`, [subId]);
        if (!sub) throw new Error('الاشتراك غير موجود');
        if (sub.status === 'frozen') throw new Error('الاشتراك مجمّد بالفعل');

        await query(
            `UPDATE subscriptions SET status='frozen', frozen_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [subId]
        );
        await this.log(adminId, adminUsername, 'SUBSCRIPTION_FROZEN', `ID: ${subId} - ${note}`, ip);
    }

    /** تفعيل الاشتراك (إلغاء التجميد أو إعادة التفعيل) */
    async activateSubscription(subId, adminId, adminUsername, note = '', ip = null) {
        const sub = await queryOne(`SELECT * FROM subscriptions WHERE id=$1`, [subId]);
        if (!sub) throw new Error('الاشتراك غير موجود');

        // إذا كان مجمّداً: احسب الوقت المجمّد وأضفه للانتهاء
        let newExpiry = sub.expires_at;
        if (sub.status === 'frozen' && sub.frozen_at && sub.expires_at) {
            const frozenMs = Date.now() - new Date(sub.frozen_at).getTime();
            newExpiry = new Date(new Date(sub.expires_at).getTime() + frozenMs).toISOString();
        }

        await query(
            `UPDATE subscriptions
             SET status='active', frozen_at=NULL, frozen_until=NULL,
                 expires_at=$1, updated_at=NOW()
             WHERE id=$2`,
            [newExpiry, subId]
        );
        await this.log(adminId, adminUsername, 'SUBSCRIPTION_ACTIVATED', `ID: ${subId} - ${note}`, ip);
    }

    /** إحصائيات الاشتراكات */
    async getSubscriptionStats() {
        const [total, active, expired, frozen, lifetime, expiringSoon] = await Promise.all([
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions`),
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='active' AND (expires_at IS NULL OR expires_at > NOW())`),
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= NOW()`),
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='frozen'`),
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions WHERE plan_type='lifetime' AND status='active'`),
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='active' AND expires_at IS NOT NULL AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '7 days'`),
        ]);

        const byPlan = await queryAll(
            `SELECT plan_type, COUNT(*) as cnt FROM subscriptions WHERE status='active' GROUP BY plan_type ORDER BY cnt DESC`
        );

        // نمو الاشتراكات آخر 30 يوم
        const growth = await queryAll(
            `SELECT DATE(created_at) as day, COUNT(*) as cnt
             FROM subscriptions
             WHERE created_at > NOW() - INTERVAL '30 days'
             GROUP BY day ORDER BY day ASC`
        );

        return {
            total:       parseInt(total?.cnt   || 0),
            active:      parseInt(active?.cnt  || 0),
            expired:     parseInt(expired?.cnt || 0),
            frozen:      parseInt(frozen?.cnt  || 0),
            lifetime:    parseInt(lifetime?.cnt || 0),
            expiringSoon:parseInt(expiringSoon?.cnt || 0),
            byPlan,
            growth
        };
    }

    /** التحقق من الاشتراكات المنتهية وتحديث حالتها */
    async expireStaleSubscriptions() {
        const result = await query(
            `UPDATE subscriptions SET status='cancelled', updated_at=NOW()
             WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= NOW()`
        );
        return result?.rowCount || 0;
    }

    // ── Refresh Tokens ────────────────────────────────────────────────────────
    async saveRefreshToken(userId, tokenHash, ip, userAgent, expiresAt) {
        await query(
            `INSERT INTO refresh_tokens (id, user_id, token_hash, ip, user_agent, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [crypto.randomUUID(), userId, tokenHash, ip, userAgent, expiresAt]
        );
    }

    async findRefreshToken(tokenHash) {
        return queryOne(
            `SELECT * FROM refresh_tokens WHERE token_hash=$1 AND revoked=FALSE AND expires_at > NOW()`,
            [tokenHash]
        );
    }

    async revokeRefreshToken(tokenHash) {
        await query(`UPDATE refresh_tokens SET revoked=TRUE WHERE token_hash=$1`, [tokenHash]);
    }

    async revokeAllUserTokens(userId) {
        await query(`UPDATE refresh_tokens SET revoked=TRUE WHERE user_id=$1`, [userId]);
    }

    // ── Session Data ──────────────────────────────────────────────────────────
    async saveSessionData(accountId, key, value) {
        const serialized = typeof value === 'string' ? value : JSON.stringify(value);
        await query(
            `INSERT INTO session_data (account_id, key, value, updated_at)
             VALUES ($1,$2,$3,NOW())
             ON CONFLICT (account_id, key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`,
            [accountId, key, serialized]
        );
    }

    async getSessionData(accountId, key) {
        const row = await queryOne(
            `SELECT value FROM session_data WHERE account_id=$1 AND key=$2`,
            [accountId, key]
        );
        if (!row) return null;
        try { return JSON.parse(row.value); } catch { return row.value; }
    }

    async deleteSessionData(accountId, key) {
        await query(`DELETE FROM session_data WHERE account_id=$1 AND key=$2`, [accountId, key]);
    }

    async deleteAllSessionData(accountId) {
        await query(`DELETE FROM session_data WHERE account_id=$1`, [accountId]);
    }

    // ── Account Helpers ───────────────────────────────────────────────────────
    async updateAccountHealth(accountId, healthStatus) {
        await query(
            `UPDATE accounts SET health_status=$1, updated_at=NOW() WHERE id=$2`,
            [healthStatus, accountId]
        ).catch(err => console.error('[SystemDB] updateAccountHealth:', err.message));
    }

    async updateMessageStats(accountId) {
        await query(
            `UPDATE accounts SET messages_sent_today=messages_sent_today+1, last_activity_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [accountId]
        ).catch(err => console.error('[SystemDB] updateMessageStats:', err.message));
    }

    _generateLicenseKey() {
        return 'LIC-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    }
}

module.exports = new SystemDB();
