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
                id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                user_id      TEXT,
                username     TEXT,
                action       TEXT,
                entity_type  TEXT,
                entity_id    TEXT,
                performed_by TEXT,
                details      TEXT,
                ip           TEXT,
                created_at   TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id)`);
        await query(`CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_log(created_at DESC)`);
        // ── ترقية جدول audit_log للتثبيتات القديمة ───────────────────────────
        await query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_type  TEXT`).catch(() => {});
        await query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entity_id    TEXT`).catch(() => {});
        await query(`ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS performed_by TEXT`).catch(() => {});

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

        // ── WhatsApp Connection Methods (الطرق الثلاث) ───────────────────────
        // عمود نوع الاتصال في جدول الحسابات
        // ── Anti-Ban Warmup Columns ────────────────────────────────────────────
        // ✅ FIX: إضافة أعمدة Warmup Phase المُستخدمة في WhatsAppManager._checkRateLimit
        await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT 'qr_code'`).catch(() => {});
        await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_phase      BOOLEAN DEFAULT TRUE`).catch(() => {});
        await query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS warmup_started_at TIMESTAMP DEFAULT NOW()`).catch(() => {});

        // ── Indexes على accounts ──────────────────────────────────────────────
        await query(`CREATE INDEX IF NOT EXISTS idx_accounts_user   ON accounts(user_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_accounts_warmup ON accounts(warmup_phase, warmup_started_at)`).catch(() => {});

        // ── FK: accounts.user_id → users.id (ON DELETE SET NULL) ─────────────
        // ⚠️ يُطبَّق فقط إذا لم يكن القيد موجوداً مسبقاً
        await query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE constraint_name = 'fk_accounts_user'
                      AND table_name = 'accounts'
                ) THEN
                    -- تنظيف أي orphan records أولاً لتجنب فشل إضافة القيد
                    UPDATE accounts SET user_id = NULL
                    WHERE user_id IS NOT NULL
                      AND user_id NOT IN (SELECT id FROM users);

                    ALTER TABLE accounts
                    ADD CONSTRAINT fk_accounts_user
                    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
                END IF;
            END
            $$
        `).catch((err) => {
            console.warn('[SystemDB] Could not add FK fk_accounts_user:', err.message);
        });

        // جدول إعدادات WhatsApp Business API
        await query(`
            CREATE TABLE IF NOT EXISTS whatsapp_business_settings (
                id                    TEXT PRIMARY KEY,
                account_id            TEXT UNIQUE NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                phone_number_id       TEXT,
                business_account_id   TEXT,
                access_token_encrypted TEXT,
                verify_token          TEXT,
                webhook_url           TEXT,
                is_verified           BOOLEAN DEFAULT FALSE,
                last_tested_at        TIMESTAMP,
                created_at            TIMESTAMP DEFAULT NOW(),
                updated_at            TIMESTAMP DEFAULT NOW()
            )
        `);
        await query(`CREATE INDEX IF NOT EXISTS idx_wbs_account ON whatsapp_business_settings(account_id)`).catch(() => {});

        // ── Connection Diagnostics (نظام التشخيص) ────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS connection_diagnostics (
                id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id       TEXT NOT NULL,
                diagnostic_type  TEXT NOT NULL,
                category         TEXT NOT NULL,
                failure_stage    TEXT,
                failure_reason   TEXT,
                technical_details TEXT,
                root_cause       TEXT,
                evidence         TEXT,
                recommended_fix  TEXT,
                confidence_score INTEGER DEFAULT 0,
                created_at       TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_diag_account  ON connection_diagnostics(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_diag_created  ON connection_diagnostics(created_at DESC)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_diag_category ON connection_diagnostics(category)`).catch(() => {});

        // ── Runtime Analysis — Phase 2 ────────────────────────────────────────
        // جدول محاولات الاتصال: يسجل كل محاولة من البداية للنهاية
        await query(`
            CREATE TABLE IF NOT EXISTS connection_attempts (
                id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id       TEXT NOT NULL,
                connection_type  TEXT NOT NULL DEFAULT 'qr_code',
                started_at       TIMESTAMP NOT NULL DEFAULT NOW(),
                ended_at         TIMESTAMP,
                duration_ms      INTEGER,
                outcome          TEXT NOT NULL DEFAULT 'in_progress',
                failure_stage    TEXT,
                failure_reason   TEXT,
                reconnect_attempt INTEGER DEFAULT 0,
                created_at       TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_attempts_account  ON connection_attempts(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_attempts_started  ON connection_attempts(started_at DESC)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_attempts_outcome  ON connection_attempts(outcome)`).catch(() => {});

        // جدول أحداث الاتصال: timeline تفصيلي لكل محاولة
        await query(`
            CREATE TABLE IF NOT EXISTS connection_events (
                id                    TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id            TEXT NOT NULL,
                attempt_id            TEXT NOT NULL REFERENCES connection_attempts(id) ON DELETE CASCADE,
                event_type            TEXT NOT NULL,
                stage                 TEXT,
                event_data            TEXT,
                severity              TEXT DEFAULT 'info',
                duration_from_start_ms INTEGER,
                created_at            TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_events_attempt   ON connection_events(attempt_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_events_account   ON connection_events(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_events_severity  ON connection_events(severity)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_events_created   ON connection_events(created_at DESC)`).catch(() => {});

        // ── Connection Cycle Analysis — Phase 3 ───────────────────────────────
        await query(`
            CREATE TABLE IF NOT EXISTS connection_stage_transitions (
                id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id              TEXT NOT NULL,
                attempt_id              TEXT REFERENCES connection_attempts(id) ON DELETE CASCADE,
                connection_type         TEXT DEFAULT 'qr_code',
                from_stage              TEXT,
                to_stage                TEXT NOT NULL,
                from_stage_duration_ms  INTEGER,
                transition_at           TIMESTAMP NOT NULL DEFAULT NOW(),
                is_unexpected           BOOLEAN DEFAULT FALSE,
                is_terminal             BOOLEAN DEFAULT FALSE,
                progress_pct            INTEGER DEFAULT 0,
                extra_data              TEXT
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_cst_account    ON connection_stage_transitions(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_cst_attempt    ON connection_stage_transitions(attempt_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_cst_stage      ON connection_stage_transitions(to_stage)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_cst_time       ON connection_stage_transitions(transition_at DESC)`).catch(() => {});

        // جدول الشذوذات
        await query(`
            CREATE TABLE IF NOT EXISTS cycle_anomalies (
                id                      TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id              TEXT NOT NULL,
                attempt_id              TEXT REFERENCES connection_attempts(id) ON DELETE CASCADE,
                anomaly_type            TEXT NOT NULL,
                stage                   TEXT NOT NULL,
                duration_ms             INTEGER,
                threshold_warn_ms       INTEGER,
                threshold_critical_ms   INTEGER,
                severity                TEXT DEFAULT 'warning',
                message                 TEXT,
                created_at              TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_anomaly_account  ON cycle_anomalies(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_anomaly_attempt  ON cycle_anomalies(attempt_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_anomaly_severity ON cycle_anomalies(severity)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_anomaly_time     ON cycle_anomalies(created_at DESC)`).catch(() => {});

        // ── QR Code Analysis — Phase 7 ───────────────────────────────────────
        // جدول تتبع كل رمز QR يُولَّد: وقت التوليد، المسح، النتيجة
        await query(`
            CREATE TABLE IF NOT EXISTS qr_flow_log (
                id                   TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id           TEXT NOT NULL,
                attempt_id           TEXT REFERENCES connection_attempts(id) ON DELETE CASCADE,
                qr_index             INTEGER DEFAULT 1,
                generation_delay_ms  INTEGER,
                generated_at         TIMESTAMP NOT NULL DEFAULT NOW(),
                scanned_at           TIMESTAMP,
                scan_delay_ms        INTEGER,
                outcome              TEXT NOT NULL DEFAULT 'pending',
                created_at           TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_qrlog_account  ON qr_flow_log(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_qrlog_attempt  ON qr_flow_log(attempt_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_qrlog_outcome  ON qr_flow_log(outcome)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_qrlog_gen      ON qr_flow_log(generated_at DESC)`).catch(() => {});

        // ── Pairing Code Analysis — Phase 8 ─────────────────────────────────
        // جدول تتبع كل عملية Pairing Code: أزمنة التأخير الثلاثة + النتيجة
        await query(`
            CREATE TABLE IF NOT EXISTS pairing_code_log (
                id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id          TEXT NOT NULL,
                attempt_id          TEXT REFERENCES connection_attempts(id) ON DELETE CASCADE,
                phone_number        TEXT,
                request_delay_ms    INTEGER,
                display_delay_ms    INTEGER,
                entry_delay_ms      INTEGER,
                code_ready_at       TIMESTAMP,
                entered_at          TIMESTAMP,
                connected_at        TIMESTAMP,
                outcome             TEXT NOT NULL DEFAULT 'pending',
                error_message       TEXT,
                created_at          TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_pairlog_account ON pairing_code_log(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_pairlog_attempt ON pairing_code_log(attempt_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_pairlog_outcome ON pairing_code_log(outcome)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_pairlog_created ON pairing_code_log(created_at DESC)`).catch(() => {});

        // ── Baileys Deep Analysis — Phase 9 ─────────────────────────────────
        // جدول تتبع أحداث Baileys الداخلية: socket events, message events, presence
        await query(`
            CREATE TABLE IF NOT EXISTS baileys_event_log (
                id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id          TEXT NOT NULL,
                attempt_id          TEXT REFERENCES connection_attempts(id) ON DELETE CASCADE,
                event_category      TEXT NOT NULL,
                event_name          TEXT NOT NULL,
                event_data          JSONB,
                processing_time_ms  INTEGER,
                error_message       TEXT,
                severity            TEXT NOT NULL DEFAULT 'info',
                created_at          TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_baileys_account  ON baileys_event_log(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_baileys_attempt  ON baileys_event_log(attempt_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_baileys_category ON baileys_event_log(event_category)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_baileys_severity ON baileys_event_log(severity)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_baileys_created  ON baileys_event_log(created_at DESC)`).catch(() => {});

        // ── Baileys Message Flow — Phase 9 ──────────────────────────────────
        // جدول تتبع تدفق الرسائل: الإرسال، التسليم، القراءة، الأخطاء
        await query(`
            CREATE TABLE IF NOT EXISTS baileys_message_flow (
                id                  TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                account_id          TEXT NOT NULL,
                message_id          TEXT,
                jid                 TEXT,
                direction           TEXT NOT NULL DEFAULT 'outbound',
                send_delay_ms       INTEGER,
                delivery_delay_ms   INTEGER,
                read_delay_ms       INTEGER,
                status              TEXT NOT NULL DEFAULT 'pending',
                error_code          TEXT,
                error_message       TEXT,
                retry_count         INTEGER DEFAULT 0,
                created_at          TIMESTAMP DEFAULT NOW()
            )
        `).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_msgflow_account  ON baileys_message_flow(account_id)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_msgflow_status   ON baileys_message_flow(status)`).catch(() => {});
        await query(`CREATE INDEX IF NOT EXISTS idx_msgflow_created  ON baileys_message_flow(created_at DESC)`).catch(() => {});

        console.log('[SystemDB] ✅ جميع الجداول جاهزة (PostgreSQL).');
    }

    async seedSuperAdmin() {
        const existing = await queryOne(`SELECT id FROM users WHERE role IN ('superadmin','super_admin','owner') LIMIT 1`);
        if (existing) {
            // ✅ FIX: تأكد من وجود اشتراك للمدير الحالي (قد يكون فات في run سابق)
            const hasSub = await queryOne(`SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active' LIMIT 1`, [existing.id]);
            if (!hasSub) {
                await query(
                    `INSERT INTO subscriptions (id, user_id, plan_type, expires_at, status, note, created_by)
                     VALUES ($1, $2, 'lifetime', NULL, 'active', 'اشتراك دائم - المالك', $2)
                     ON CONFLICT DO NOTHING`,
                    [crypto.randomUUID(), existing.id]
                ).catch(e => console.warn('[SystemDB] Sub insert skipped:', e.message));
            }
            return;
        }
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
        // ✅ FIX: اجلب الـ ID الفعلي من قاعدة البيانات بعد INSERT لتفادي FK error عند conflict
        const actualUser = await queryOne(`SELECT id FROM users WHERE username = $1`, [adminUser]);
        const actualId   = actualUser?.id || id;
        // إضافة اشتراك دائم تلقائياً للمدير الرئيسي
        await query(
            `INSERT INTO subscriptions (id, user_id, plan_type, expires_at, status, note, created_by)
             VALUES ($1, $2, 'lifetime', NULL, 'active', 'اشتراك دائم - المالك', $2)
             ON CONFLICT DO NOTHING`,
            [crypto.randomUUID(), actualId]
        ).catch(e => console.warn('[SystemDB] Sub insert skipped:', e.message));
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

    /**
     * ✅ جلب حساب مع التحقق من Warmup Phase
     * يُحدِّث warmup_phase تلقائياً بعد انتهاء فترة الـ warmupDays
     */
    async getAccountWithWarmup(accountId) {
        const account = await queryOne(
            `SELECT id, warmup_phase, warmup_started_at FROM accounts WHERE id = $1`,
            [accountId]
        );
        if (!account) return null;

        // إذا كان في Warmup وانتهت المدة → أنهِ الـ Warmup تلقائياً
        if (account.warmup_phase && account.warmup_started_at) {
            const warmupDays = parseInt(process.env.WARMUP_DAYS || '7', 10);
            const elapsed    = Date.now() - new Date(account.warmup_started_at).getTime();
            if (elapsed >= warmupDays * 86_400_000) {
                await query(
                    `UPDATE accounts SET warmup_phase = FALSE, updated_at = NOW() WHERE id = $1`,
                    [accountId]
                ).catch(() => {});
                account.warmup_phase = false;
            }
        }
        return account;
    }

    /** تصفير عداد الرسائل اليومي لجميع الحسابات */
    async resetDailyMessageCounters() {
        const result = await query(
            `UPDATE accounts SET messages_sent_today = 0, updated_at = NOW()`
        );
        return result?.rowCount || 0;
    }

    _generateLicenseKey() {
        return 'LIC-' + crypto.randomBytes(12).toString('hex').toUpperCase();
    }
}

module.exports = new SystemDB();
