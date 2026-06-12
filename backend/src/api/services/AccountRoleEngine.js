'use strict';
/**
 * AccountRoleEngine — محرك الأدوار والمهام الخلفية
 *
 * يعمل 24/7 على السيرفر بشكل مستقل عن المستخدم.
 * يقرأ أدوار الحسابات من قاعدة البيانات وينفذ المهام المناسبة:
 *
 *   publisher  → تشغيل الجداول الزمنية + نشر الإعلانات
 *   searcher   → استخراج الروابط من رسائل المجموعات
 *   joiner     → الانضمام للمجموعات من قائمة الانتظار
 *   monitor    → مراقبة المجموعات واكتشاف الروابط الجديدة
 *   stopped    → لا شيء
 */

const crypto           = require('crypto');
const DatabaseManager  = require('../../database/DatabaseManager');
const SystemDB         = require('../../database/SystemDB');

// فترة الفحص الدورية (كل 45 ثانية)
const TICK_INTERVAL_MS  = 45_000;

// فترة فحص الانضمام (كل دقيقتين لتجنب الحظر)
const JOIN_TICK_MS      = 120_000;

// الحد الأقصى للانضمام في الدفعة الواحدة لكل حساب
const MAX_JOIN_BATCH    = 2;

class AccountRoleEngine {
    constructor() {
        this.isRunning      = false;
        this.mainTicker     = null;
        this.joinTicker     = null;
        this.jobScheduler   = null;
        this.whatsappManager = null;
        // تتبع آخر تشغيل لكل حساب لمنع التكرار
        this.lastPublisherRun = new Map(); // accountId → timestamp
    }

    /**
     * حقن الـ dependencies بعد التهيئة (لتجنب Circular Require)
     */
    setDependencies(jobScheduler, whatsappManager) {
        this.jobScheduler    = jobScheduler;
        this.whatsappManager = whatsappManager;
    }

    // ── بدء محرك الأدوار ───────────────────────────────────────────────────
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        console.log('[RoleEngine] Starting Account Role Engine...');

        // Tick رئيسي: publisher + searcher + monitor
        this.mainTicker = setInterval(() => {
            this._mainTick().catch(err =>
                console.error('[RoleEngine] Main tick error:', err.message)
            );
        }, TICK_INTERVAL_MS);

        // Tick الانضمام (أبطأ لتجنب الحظر)
        this.joinTicker = setInterval(() => {
            this._joinTick().catch(err =>
                console.error('[RoleEngine] Join tick error:', err.message)
            );
        }, JOIN_TICK_MS);

        // تشغيل أول مرة بعد 10 ثوانٍ من بدء الخادم
        setTimeout(() => {
            this._mainTick().catch(() => {});
            this._joinTick().catch(() => {});
        }, 10_000);

        console.log('[RoleEngine] ✓ Running. Publisher/Searcher/Monitor tick every 45s, Joiner every 2min.');
    }

    // ── إيقاف المحرك ───────────────────────────────────────────────────────
    stop() {
        this.isRunning = false;
        if (this.mainTicker) { clearInterval(this.mainTicker); this.mainTicker = null; }
        if (this.joinTicker) { clearInterval(this.joinTicker); this.joinTicker = null; }
        console.log('[RoleEngine] Stopped.');
    }

    // ── الـ Tick الرئيسي ────────────────────────────────────────────────────
    async _mainTick() {
        const accounts = await SystemDB.all(`
            SELECT id, role, task_status, status FROM accounts
            WHERE task_status = 'running' AND role != 'stopped'
        `).catch(() => []);

        for (const acc of accounts) {
            if (acc.status !== 'connected') continue; // لا تعمل إلا مع حسابات متصلة

            switch (acc.role) {
                case 'publisher':
                    await this._runPublisher(acc.id).catch(e =>
                        console.error(`[RoleEngine][publisher] Account ${acc.id}:`, e.message)
                    );
                    break;
                case 'searcher':
                    await this._runSearcher(acc.id).catch(e =>
                        console.error(`[RoleEngine][searcher] Account ${acc.id}:`, e.message)
                    );
                    break;
                case 'monitor':
                    await this._runMonitor(acc.id).catch(e =>
                        console.error(`[RoleEngine][monitor] Account ${acc.id}:`, e.message)
                    );
                    break;
            }
        }

        // تحديث last_activity_at لجميع الحسابات النشطة
        if (accounts.length > 0) {
            await SystemDB.run(
                `UPDATE accounts SET last_activity_at = NOW() WHERE task_status = 'running' AND role != 'stopped'`
            ).catch(() => {});
        }
    }

    // ── Publisher: تشغيل الجداول الزمنية للنشر ──────────────────────────────
    async _runPublisher(accountId) {
        if (!this.jobScheduler) return;

        const accountDB = await DatabaseManager.getAccountDB(accountId);

        // البحث عن جداول نشر حان وقت تنفيذها
        const dueSchedules = await accountDB.all(`
            SELECT bs.id, bs.name, bs.ad_library_ids, bs.target_group_jids,
                   bs.rotation_mode, bs.max_per_day, bs.executions_done
            FROM broadcast_schedules bs
            WHERE bs.account_id = $1
              AND bs.status = 'active'
              AND bs.next_run_at <= NOW()
            LIMIT 5
        `, [accountId]);

        for (const schedule of dueSchedules) {
            try {
                const adIds    = JSON.parse(schedule.ad_library_ids  || '[]');
                const groupIds = JSON.parse(schedule.target_group_jids || '[]');

                if (!adIds.length || !groupIds.length) continue;

                // اختيار الإعلان حسب نمط التدوير
                let selectedAdId;
                if (schedule.rotation_mode === 'random') {
                    selectedAdId = adIds[Math.floor(Math.random() * adIds.length)];
                } else {
                    // sequential: دور بالتسلسل
                    const idx = schedule.executions_done % adIds.length;
                    selectedAdId = adIds[idx];
                }

                // التحقق من الحد اليومي
                if (schedule.executions_done >= schedule.max_per_day) {
                    console.log(`[RoleEngine][publisher] Schedule ${schedule.id}: daily limit reached.`);
                    continue;
                }

                // جدولة رسالة لكل مجموعة مستهدفة
                for (const groupJid of groupIds) {
                    await this.jobScheduler.scheduleTask(accountId, 'send_scheduled_message', {
                        scheduleId:   schedule.id,
                        adLibraryId:  selectedAdId,
                        targetJid:    groupJid,
                        source:       'role_engine',
                    }, new Date(), 5);
                }

                // تحديث next_run_at (نفترض hourly كـ default — يمكن تخصيصه)
                const nextRun = new Date(Date.now() + 60 * 60 * 1000); // بعد ساعة
                await accountDB.run(`
                    UPDATE broadcast_schedules
                    SET next_run_at    = $1,
                        last_run_at    = NOW(),
                        executions_done = executions_done + 1,
                        updated_at     = NOW()
                    WHERE id = $2
                `, [nextRun, schedule.id]);

                console.log(`[RoleEngine][publisher] Account ${accountId}: Scheduled broadcast for ${groupIds.length} groups.`);

            } catch (err) {
                console.error(`[RoleEngine][publisher] Schedule ${schedule.id} error:`, err.message);
            }
        }

        this.lastPublisherRun.set(accountId, Date.now());
    }

    // ── Searcher: تفعيل وضع البحث وتحديث إعدادات الاستخراج ─────────────────
    async _runSearcher(accountId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);

        // التأكد من أن الحساب مُفعَّل في إعدادات البحث
        const settings = await accountDB.get(
            `SELECT id, allowed_account_ids FROM link_search_settings WHERE id = 'default'`
        );

        if (!settings) {
            // إنشاء إعدادات البحث إذا لم تكن موجودة
            await accountDB.run(`
                INSERT INTO link_search_settings (id, allowed_account_ids, deep_search_enabled, updated_at)
                VALUES ('default', $1, TRUE, NOW())
                ON CONFLICT (id) DO NOTHING
            `, [JSON.stringify([accountId])]);
        } else {
            // إضافة الحساب إلى القائمة المسموح بها إذا لم يكن فيها
            let allowedIds = [];
            try { allowedIds = JSON.parse(settings.allowed_account_ids || '[]'); } catch {}

            if (!allowedIds.includes(accountId)) {
                allowedIds.push(accountId);
                await accountDB.run(`
                    UPDATE link_search_settings
                    SET allowed_account_ids = $1, updated_at = NOW()
                    WHERE id = 'default'
                `, [JSON.stringify(allowedIds)]);
            }
        }

        // تسجيل في السجل
        await this._logActivity(accountId, 'searcher', 'فحص وتحديث إعدادات البحث عن الروابط');
    }

    // ── Monitor: مراقبة المجموعات وتحديث قاعدة البيانات ──────────────────────
    async _runMonitor(accountId) {
        const sock = this.whatsappManager?.getSession(accountId);
        if (!sock) return;

        const accountDB = await DatabaseManager.getAccountDB(accountId);

        // جلب المجموعات الخاصة بهذا الحساب
        const groups = await accountDB.all(
            `SELECT group_id, name FROM groups LIMIT 50`
        );

        for (const group of groups) {
            if (!group.group_id) continue;

            try {
                // جلب metadata المجموعة (يكشف عن الأعضاء الجدد والروابط)
                const meta = await sock.groupMetadata(group.group_id).catch(() => null);
                if (!meta) continue;

                // تحديث اسم المجموعة إن تغير
                if (meta.subject && meta.subject !== group.name) {
                    await accountDB.run(
                        `UPDATE groups SET name = $1 WHERE group_id = $2`,
                        [meta.subject, group.group_id]
                    );
                }

                // البحث عن روابط الدعوة في وصف المجموعة
                const description = meta.desc || '';
                if (description) {
                    const LinkExtractorService = require('./LinkExtractorService');
                    await LinkExtractorService.processMessage(accountId, {
                        text:       description,
                        senderJid:  'monitor@system',
                        groupJid:   group.group_id,
                        messageId:  `monitor_${group.group_id}_${Date.now()}`,
                    }).catch(() => {});
                }

            } catch (err) {
                // تجاهل أخطاء المجموعات الفردية
            }

            // تأخير بين المجموعات لتجنب الحظر
            await new Promise(r => setTimeout(r, 2000));
        }

        await this._logActivity(accountId, 'monitor', `مراقبة ${groups.length} مجموعة`);
    }

    // ── Joiner Tick ─────────────────────────────────────────────────────────
    async _joinTick() {
        const accounts = await SystemDB.all(`
            SELECT id, status FROM accounts
            WHERE role = 'joiner' AND task_status = 'running'
        `).catch(() => []);

        for (const acc of accounts) {
            if (acc.status !== 'connected') continue;
            await this._runJoiner(acc.id).catch(e =>
                console.error(`[RoleEngine][joiner] Account ${acc.id}:`, e.message)
            );
        }
    }

    // ── Joiner: الانضمام للمجموعات من قائمة الانتظار ────────────────────────
    async _runJoiner(accountId) {
        if (!this.jobScheduler) return;

        const accountDB = await DatabaseManager.getAccountDB(accountId);

        // جلب إعدادات الانضمام
        const joinSettings = await accountDB.get(
            `SELECT * FROM auto_join_settings WHERE id = 'default'`
        ).catch(() => null);

        if (joinSettings && !joinSettings.enabled) return;

        const maxPerDay = joinSettings?.max_joins_per_day || 10;
        const delayMin  = joinSettings?.delay_between_joins_minutes || 5;

        // التحقق من عدد الانضمامات اليوم
        const todayJoins = await accountDB.get(`
            SELECT COUNT(*) as cnt FROM auto_join_queue
            WHERE target_account_id = $1
              AND status = 'joined'
              AND joined_at >= NOW() - INTERVAL '24 hours'
        `, [accountId]);

        const joinedToday = parseInt(todayJoins?.cnt || '0', 10);
        if (joinedToday >= maxPerDay) {
            console.log(`[RoleEngine][joiner] Account ${accountId}: Daily limit reached (${joinedToday}/${maxPerDay})`);
            return;
        }

        const remaining = Math.min(MAX_JOIN_BATCH, maxPerDay - joinedToday);

        // جلب الروابط المنتظرة
        const pendingJoins = await accountDB.all(`
            SELECT ajq.id, ajq.invite_code, el.url
            FROM auto_join_queue ajq
            LEFT JOIN extracted_links el ON el.id = ajq.link_id
            WHERE (ajq.target_account_id = $1 OR ajq.target_account_id IS NULL)
              AND ajq.status = 'pending'
              AND (ajq.scheduled_at IS NULL OR ajq.scheduled_at <= NOW())
            ORDER BY ajq.created_at ASC
            LIMIT $2
        `, [accountId, remaining]);

        for (const joinTask of pendingJoins) {
            const inviteCode = joinTask.invite_code
                || this._extractInviteCode(joinTask.url);

            if (!inviteCode) continue;

            // جدولة مهمة الانضمام عبر BullMQ
            const delayMs = delayMin * 60 * 1000 * (0.5 + Math.random() * 0.5);
            await this.jobScheduler.scheduleTask(accountId, 'join_group', {
                joinQueueId:  joinTask.id,
                inviteCode,
                source:       'role_engine',
            }, new Date(Date.now() + delayMs), 3);

            // تحديث الحالة لـ 'scheduled'
            await accountDB.run(
                `UPDATE auto_join_queue SET status = 'scheduled', target_account_id = $1, scheduled_at = $2 WHERE id = $3`,
                [accountId, new Date(Date.now() + delayMs), joinTask.id]
            );

            console.log(`[RoleEngine][joiner] Account ${accountId}: Queued join for ${inviteCode}`);
        }

        if (pendingJoins.length > 0) {
            await this._logActivity(accountId, 'joiner', `جدولة ${pendingJoins.length} انضمام جديد`);
        }
    }

    // ── استخراج كود الدعوة من الرابط ─────────────────────────────────────────
    _extractInviteCode(url) {
        if (!url) return null;
        const match = url.match(/(?:chat\.whatsapp\.com\/|whatsapp:\/\/invite\?code=)([A-Za-z0-9_-]+)/);
        return match ? match[1] : null;
    }

    // ── تسجيل نشاط الحساب ────────────────────────────────────────────────────
    async _logActivity(accountId, role, message) {
        await SystemDB.run(
            `UPDATE accounts SET last_activity_at = NOW() WHERE id = $1`,
            [accountId]
        ).catch(() => {});
    }

    // ── تحديث دور الحساب وبدء/إيقاف المهام ────────────────────────────────────
    async setAccountRole(accountId, role) {
        await SystemDB.run(
            `UPDATE accounts SET role = $1, updated_at = NOW() WHERE id = $2`,
            [role, accountId]
        );

        console.log(`[RoleEngine] Account ${accountId} → role set to '${role}'`);

        // للحسابات الـ searcher: تحديث إعدادات البحث فوراً
        if (role === 'searcher') {
            const accountDB = await DatabaseManager.getAccountDB(accountId).catch(() => null);
            if (accountDB) {
                await this._runSearcher(accountId).catch(() => {});
            }
        }
    }

    // ── تشغيل/إيقاف مهام الحساب ─────────────────────────────────────────────
    async startAccount(accountId) {
        await SystemDB.run(
            `UPDATE accounts SET task_status = 'running', last_activity_at = NOW() WHERE id = $1`,
            [accountId]
        );
        console.log(`[RoleEngine] Account ${accountId} → task_status = running`);
    }

    async stopAccount(accountId) {
        await SystemDB.run(
            `UPDATE accounts SET task_status = 'paused', last_activity_at = NOW() WHERE id = $1`,
            [accountId]
        );
        console.log(`[RoleEngine] Account ${accountId} → task_status = paused`);

        // إيقاف جداول النشر للحساب
        const accountDB = await DatabaseManager.getAccountDB(accountId).catch(() => null);
        if (accountDB) {
            await accountDB.run(
                `UPDATE broadcast_schedules SET status = 'paused' WHERE account_id = $1 AND status = 'active'`,
                [accountId]
            ).catch(() => {});
        }
    }

    // ── ملخص أدوار جميع الحسابات ─────────────────────────────────────────────
    async getSummary() {
        const rows = await SystemDB.all(`
            SELECT
                COUNT(*)                                       AS total,
                COUNT(*) FILTER (WHERE status = 'connected')  AS connected,
                COUNT(*) FILTER (WHERE task_status = 'running') AS running,
                COUNT(*) FILTER (WHERE role = 'publisher')    AS publishers,
                COUNT(*) FILTER (WHERE role = 'searcher')     AS searchers,
                COUNT(*) FILTER (WHERE role = 'joiner')       AS joiners,
                COUNT(*) FILTER (WHERE role = 'monitor')      AS monitors,
                COUNT(*) FILTER (WHERE role = 'stopped')      AS stopped
            FROM accounts
        `).catch(() => [{}]);
        return rows[0] || {};
    }
}

module.exports = new AccountRoleEngine();

