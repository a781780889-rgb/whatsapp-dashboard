'use strict';
/**
 * GroupSyncService — مزامنة تلقائية للمجموعات في الخلفية
 * يُشغَّل كـ Singleton عند بدء الخادم ويزامن مجموعات جميع الحسابات
 * المتصلة تلقائياً وفق إعداداتها المحفوظة
 *
 * الإصلاح: المسار الصحيح لـ WhatsAppManager
 */
const WhatsAppManager = require('../../bot/WhatsAppManager');   // ✅ مسار صحيح
const DatabaseManager = require('../../database/DatabaseManager');

class GroupSyncService {
    constructor() {
        this._timer   = null;
        this._running = false;
        this._syncing = new Set(); // accounts being synced now — avoid overlap
    }

    // ── بدء الخدمة ─────────────────────────────────────────────────────────
    start() {
        if (this._running) return;
        this._running = true;
        // يفحص كل دقيقة هل حان وقت المزامنة لأي حساب
        this._timer = setInterval(() => this._tick(), 60 * 1000);
        console.log('[GroupSyncService] Started. Checking every 60s.');
        // فحص فوري عند البدء
        setTimeout(() => this._tick(), 5000);
    }

    stop() {
        this._running = false;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        console.log('[GroupSyncService] Stopped.');
    }

    // ── دورة الفحص ─────────────────────────────────────────────────────────
    async _tick() {
        if (!this._running) return;
        try {
            const GroupController = require('../controllers/GroupController');
            // ✅ FIX: WhatsAppManager.sessions غير متاح كخاصية خارجية (closure داخلي)
            //         — استخدام الدالة العامة الجديدة getConnectedAccountIds() بدلاً منه.
            //         قبل هذا الإصلاح كانت هذه السطر تفشل بصمت كل 60 ثانية، فلم
            //         تكن المزامنة التلقائية تعمل فعلياً أبداً.
            const sessions = WhatsAppManager.getConnectedAccountIds();

            for (const accountId of sessions) {
                if (this._syncing.has(accountId)) continue;

                const sock = WhatsAppManager.getSession(accountId);
                if (!sock) continue;

                try {
                    const accountDB = await DatabaseManager.getAccountDB(accountId);
                    await GroupController._ensureSyncSettingsTable(accountDB);
                    await GroupController._ensureGroupsTable(accountDB);

                    // جلب إعدادات المزامنة
                    const settings = await accountDB.get(
                        `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
                    );

                    if (!settings || !settings.auto_sync_enabled) continue;

                    const intervalMs = (settings.interval_minutes || 15) * 60 * 1000;
                    const lastSync   = settings.last_auto_sync
                        ? new Date(settings.last_auto_sync).getTime() : 0;

                    if (Date.now() - lastSync < intervalMs) continue; // لم يحن الوقت

                    // حان وقت المزامنة
                    this._syncing.add(accountId);
                    console.log(`[GroupSyncService] Auto-syncing account ${accountId}...`);

                    GroupController._syncFromWhatsApp(accountId, sock, accountDB)
                        .then(async () => {
                            await accountDB.run(
                                `UPDATE group_sync_settings
                                 SET last_auto_sync = NOW(), updated_at = NOW()
                                 WHERE account_id = $1`, [accountId]
                            );
                            console.log(`[GroupSyncService] ✅ Done: account ${accountId}`);
                        })
                        .catch(err => {
                            console.error(`[GroupSyncService] ❌ Failed: account ${accountId}:`, err.message);
                        })
                        .finally(() => {
                            this._syncing.delete(accountId);
                        });

                } catch (err) {
                    console.error(`[GroupSyncService] Error for account ${accountId}:`, err.message);
                    this._syncing.delete(accountId);
                }
            }
        } catch (err) {
            console.error('[GroupSyncService] Tick error:', err.message);
        }
    }

    // ── مزامنة فورية بالطلب (من API) ──────────────────────────────────────
    async triggerSync(accountId) {
        if (this._syncing.has(accountId)) {
            return { success: false, error: 'مزامنة جارية بالفعل' };
        }
        const sock = WhatsAppManager.getSession(accountId);
        if (!sock) return { success: false, error: 'الحساب غير متصل' };

        try {
            const GroupController = require('../controllers/GroupController');
            const accountDB       = await DatabaseManager.getAccountDB(accountId);
            await GroupController._ensureGroupsTable(accountDB);

            this._syncing.add(accountId);
            const groups = await GroupController._syncFromWhatsApp(accountId, sock, accountDB);

            await accountDB.run(
                `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`,
                [accountId]
            ).catch(() => {});

            return { success: true, groups, count: groups.length };
        } catch (err) {
            return { success: false, error: err.message };
        } finally {
            this._syncing.delete(accountId);
        }
    }
    // ── alias — يُستخدم من QueueManager handler ('sync_groups') في index.js ──
    // ✅ FIX: كان index.js يستدعي GroupSyncService.syncAccount(accountId) وهي
    //         دالة لم تكن موجودة أصلاً (TypeError عند تنفيذ أي مهمة sync_groups).
    async syncAccount(accountId) {
        return this.triggerSync(accountId);
    }
}

module.exports = new GroupSyncService();

