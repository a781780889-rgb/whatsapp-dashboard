'use strict';
/**
 * GroupSyncService — مزامنة تلقائية للمجموعات في الخلفية
 * [FIX-ROOT-1] تمرير accountId لـ _ensureSyncSettingsTable
 * [FIX-ROOT-3] مسح الكاش بعد كل مزامنة
 */
const WhatsAppManager = require('../../bot/WhatsAppManager');
const DatabaseManager = require('../../database/DatabaseManager');
const CacheService    = require('../../lib/CacheService');

class GroupSyncService {
    constructor() {
        this._timer   = null;
        this._running = false;
        this._syncing = new Set();
    }

    start() {
        if (this._running) return;
        this._running = true;
        this._timer = setInterval(() => this._tick(), 60 * 1000);
        console.log('[GroupSyncService] Started. Checking every 60s.');
        setTimeout(() => this._tick(), 5000);
    }

    stop() {
        this._running = false;
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
        console.log('[GroupSyncService] Stopped.');
    }

    async _tick() {
        if (!this._running) return;
        try {
            const GroupController = require('../controllers/GroupController');
            const sessions = WhatsAppManager.getConnectedAccountIds();

            for (const accountId of sessions) {
                if (this._syncing.has(accountId)) continue;

                const sock = WhatsAppManager.getSession(accountId);
                if (!sock) continue;

                try {
                    const accountDB = await DatabaseManager.getAccountDB(accountId);
                    await GroupController._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]
                    await GroupController._ensureGroupsTable(accountDB);

                    const settings = await accountDB.get(
                        `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
                    );

                    if (!settings || !settings.auto_sync_enabled) continue;

                    const intervalMs = (settings.interval_minutes || 15) * 60 * 1000;
                    const lastSync   = settings.last_auto_sync
                        ? new Date(settings.last_auto_sync).getTime() : 0;

                    if (Date.now() - lastSync < intervalMs) continue;

                    this._syncing.add(accountId);
                    console.log(`[GroupSyncService] Auto-syncing account ${accountId}...`);

                    GroupController._syncFromWhatsApp(accountId, sock, accountDB)
                        .then(async (groups) => {
                            await accountDB.run(
                                `UPDATE group_sync_settings
                                 SET last_auto_sync = NOW(), updated_at = NOW()
                                 WHERE account_id = $1`, [accountId]
                            );
                            await CacheService.invalidateAccount(accountId).catch(() => {});
                            const publishable = groups.filter(g => g.publish_status === 'green').length;
                            console.log(`[GroupSyncService] ✅ Done: account ${accountId} — ${groups.length} groups (${publishable} publishable)`);
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
            await GroupController._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]

            this._syncing.add(accountId);
            const groups = await GroupController._syncFromWhatsApp(accountId, sock, accountDB);

            await accountDB.run(
                `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`,
                [accountId]
            ).catch(() => {});

            await CacheService.invalidateAccount(accountId).catch(() => {});

            const publishable = groups.filter(g => g.publish_status === 'green').length;
            console.log(`[GroupSyncService] triggerSync: ✅ account ${accountId} — ${groups.length} groups (${publishable} publishable)`);

            return { success: true, groups, count: groups.length, publishable };
        } catch (err) {
            return { success: false, error: err.message };
        } finally {
            this._syncing.delete(accountId);
        }
    }

    async syncAccount(accountId) {
        return this.triggerSync(accountId);
    }
}

module.exports = new GroupSyncService();
