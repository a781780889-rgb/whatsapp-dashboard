'use strict';
/**
 * GroupController — مجموعات واتساب الحقيقية
 * [FIX-ROOT-1] _ensureSyncSettingsTable تُدخل accountId الحقيقي لا 'default'
 * [FIX-ROOT-2] getLiveOverview يُعيد publishable_count في الـ summary
 * [FIX-ROOT-3] Cache invalidation صحيح في كل مسار sync
 * [FIX-ROOT-4] _syncFromWhatsApp تُسجّل logs تفصيلية في كل مرحلة
 * [FIX-ROOT-5] getGroups لا يُصفّر البيانات عند عدم وجود كاش
 */
const WhatsAppManager = require('../../bot/WhatsAppManager');
const DatabaseManager = require('../../database/DatabaseManager');
const CacheService    = require('../../lib/CacheService');
const SocketBridge    = require('../../core/SocketBridge');
const { v4: uuidv4 } = require('uuid');

// ─────────────────────────────────────────────────────────────────────────────
// [FIX-ROOT-6] LID/PN identity matching (Baileys v7)
// ─────────────────────────────────────────────────────────────────────────────
// Baileys v7 made @lid the primary addressing scheme for group participants.
// `meta.participants[].id` is now commonly a `...@lid` JID, while
// `sock.user.id` is a `...@s.whatsapp.net` (PN) JID — two separate ID
// namespaces that don't share a numeric portion. Comparing them directly (or
// comparing just the number before `@`) silently fails for nearly every
// group, so `isAdmin` came back false everywhere → any group with
// `announce: true` was incorrectly marked publish_status='red'.
//
// Fix: collect every identifier we have for "ourselves" (PN id, LID id,
// alt-JID) and check the participant against all of them. Each participant
// in v7 can also carry `phoneNumber` / `lid` fields alongside `id`.
function _normalizeJid(jid) {
    if (!jid) return null;
    // strip device suffix (":12@") and keep only the number/identifier + domain
    return jid.replace(/:\d+@/, '@');
}

function _selfIdentifiers(sock) {
    const ids = new Set();
    const candidates = [
        sock.user?.id,
        sock.user?.lid,
        sock.authState?.creds?.me?.id,
        sock.authState?.creds?.me?.lid,
    ];
    for (const c of candidates) {
        const n = _normalizeJid(c);
        if (n) ids.add(n);
    }
    return ids;
}

function _findSelfParticipant(participants, selfIds) {
    if (!participants) return null;
    return participants.find(p => {
        const candidates = [p.id, p.lid, p.phoneNumber, p.jid]
            .map(_normalizeJid)
            .filter(Boolean);
        return candidates.some(c => selfIds.has(c));
    }) || null;
}

// ── مساعد pagination ──────────────────────────────────────────────────────────
function parsePagination(query) {
    const page  = Math.max(1, parseInt(query.page  || '1',  10));
    const limit = Math.min(500, Math.max(1, parseInt(query.limit || '100', 10)));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}

const LIVE_FRESHNESS_WINDOW_MS = 30 * 1000;   // 30 ثانية
const LIVE_SYNC_TIMEOUT_MS     = 60 * 1000;   // 60 ثانية
const SYNC_ALL_TIMEOUT_MS      = 90 * 1000;   // 90 ثانية

function withTimeout(promise, ms, label = 'TIMEOUT') {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms)),
    ]);
}

async function listUserAccounts(req) {
    const isAdmin = req.user?.role === 'admin';
    const userId  = req.user?.id || req.user?.userId;
    if (isAdmin) {
        return DatabaseManager.systemDB.all(
            `SELECT id, name, phone_number, status FROM accounts ORDER BY created_at DESC`
        );
    }
    return DatabaseManager.systemDB.all(
        `SELECT id, name, phone_number, status FROM accounts
         WHERE user_id = $1 OR user_id IS NULL ORDER BY created_at DESC`,
        [userId]
    );
}

class GroupController {

    // ── GET /accounts/:accountId/groups ────────────────────────────────────────
    async getGroups(req, res) {
        try {
            const { accountId } = req.params;
            const forceRefresh  = req.query.refresh === '1';
            const { page, limit, offset } = parsePagination(req.query);

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);
            await this._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]

            if (forceRefresh) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    console.log(`[GroupController] getGroups: force refresh for account ${accountId}`);
                    const allSynced = await this._syncFromWhatsApp(accountId, sock, accountDB);
                    await accountDB.run(
                        `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`,
                        [accountId]
                    ).catch(() => {});
                    await CacheService.invalidateAccount(accountId);

                    const paginated = allSynced.slice(offset, offset + limit);
                    return res.json({
                        success:   true,
                        groups:    paginated,
                        count:     paginated.length,
                        total:     allSynced.length,
                        pagination: this._buildPagination(page, limit, allSynced.length),
                        source:    'whatsapp',
                        synced_at: new Date().toISOString(),
                    });
                }
                const { groups: cached2, total: total2 } = await this._getCachedGroupsPaginated(accountDB, limit, offset);
                console.log(`[GroupController] getGroups: no session, returning DB cache (${total2} groups) for ${accountId}`);
                return res.json({
                    success:    true,
                    groups:     cached2,
                    count:      cached2.length,
                    total:      total2,
                    pagination: this._buildPagination(page, limit, total2),
                    source:     'cache',
                    synced_at:  cached2[0]?.last_sync || null,
                    warning:    'جلسة واتساب غير متصلة — يُعرض الكاش المحفوظ.',
                });
            }

            // محاولة Redis Cache أولاً (الصفحة الأولى فقط)
            if (page === 1) {
                const cacheKey = CacheService.groupsKey(accountId);
                const cached = await CacheService.get(cacheKey);
                if (cached && cached.groups && cached.groups.length > 0) {
                    const paginated = cached.groups.slice(0, limit);
                    console.log(`[GroupController] getGroups: Redis cache hit (${cached.total} groups) for ${accountId}`);
                    return res.json({
                        success:    true,
                        groups:     paginated,
                        count:      paginated.length,
                        total:      cached.total,
                        pagination: this._buildPagination(1, limit, cached.total),
                        source:     'cache',
                        synced_at:  cached.synced_at,
                        sync_settings: cached.sync_settings,
                        from_cache: true,
                    });
                }
            }

            // قراءة من DB
            let [{ groups, total }, settings] = await Promise.all([
                this._getCachedGroupsPaginated(accountDB, limit, offset),
                accountDB.get(`SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]),
            ]);

            console.log(`[GroupController] getGroups: DB read — ${total} groups for account ${accountId}`);

            // [FIX-DIRECT-PUBLISH-1] إذا كان الكاش فارغاً (لم تتم أي مزامنة سابقة لهذا
            // الحساب) والحساب متصل بواتساب، نقوم بمزامنة فورية تلقائياً بدل إعادة
            // قائمة فارغة. هذا يحل مشكلة "المجموعات لا تظهر" لحساب لم يُزامَن قبلاً.
            if (total === 0) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    try {
                        console.log(`[GroupController] getGroups: empty cache — auto-syncing account ${accountId}`);
                        const allSynced = await withTimeout(
                            this._syncFromWhatsApp(accountId, sock, accountDB),
                            LIVE_SYNC_TIMEOUT_MS
                        );
                        await accountDB.run(
                            `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`,
                            [accountId]
                        ).catch(() => {});
                        await CacheService.invalidateAccount(accountId);

                        total  = allSynced.length;
                        groups = allSynced.slice(offset, offset + limit);

                        return res.json({
                            success:    true,
                            groups,
                            count:      groups.length,
                            total,
                            pagination: this._buildPagination(page, limit, total),
                            source:     'whatsapp',
                            synced_at:  new Date().toISOString(),
                            auto_synced: true,
                        });
                    } catch (autoSyncErr) {
                        console.warn(`[GroupController] getGroups: auto-sync failed for ${accountId}:`, autoSyncErr.message);
                        // نتابع بإعادة النتيجة الفارغة من DB بدل فشل الطلب بالكامل
                    }
                }
            }

            const response = {
                success:       true,
                groups,
                count:         groups.length,
                total,
                pagination:    this._buildPagination(page, limit, total),
                source:        'database',
                synced_at:     groups[0]?.last_sync || null,
                sync_settings: settings ? {
                    interval_minutes:  settings.interval_minutes,
                    auto_sync_enabled: settings.auto_sync_enabled,
                    last_auto_sync:    settings.last_auto_sync,
                } : null,
            };

            // خزّن في Redis للصفحة الأولى
            if (page === 1 && total > 0) {
                const allRows = await accountDB.all(
                    `SELECT * FROM wa_groups WHERE is_member = TRUE ORDER BY members_count DESC`
                );
                const allFormatted = allRows.map(r => this._formatGroup(r));
                await CacheService.set(
                    CacheService.groupsKey(accountId),
                    { groups: allFormatted, total: allFormatted.length, synced_at: allFormatted[0]?.last_sync || null, sync_settings: response.sync_settings },
                    CacheService.TTL.GROUPS
                );
            }

            return res.json(response);

        } catch (error) {
            console.error('[GroupController] getGroups Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:accountId/groups/categories ─────────────────────────────
    async getGroupsByCategory(req, res) {
        try {
            const { accountId } = req.params;
            const forceRefresh  = req.query.refresh === '1';
            const { page, limit, offset } = parsePagination(req.query);

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);
            await this._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]

            if (forceRefresh) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    await this._syncFromWhatsApp(accountId, sock, accountDB);
                    await CacheService.invalidateAccount(accountId);
                }
            }

            // محاولة Redis Cache
            const cacheKey = CacheService.categoriesKey(accountId);
            const cachedCat = await CacheService.get(cacheKey);
            if (cachedCat && !forceRefresh) {
                const paginatedMember = (cachedCat.members || []).slice(offset, offset + limit);
                return res.json({
                    ...cachedCat,
                    members:    paginatedMember,
                    pagination: this._buildPagination(page, limit, cachedCat.total_members || 0),
                    from_cache: true,
                });
            }

            // جلب كل المجموعات من DB
            let allRows = await accountDB.all(
                `SELECT * FROM wa_groups ORDER BY members_count DESC`
            );

            // [FIX-DIRECT-PUBLISH-1] نفس إصلاح getGroups: مزامنة تلقائية إذا كان
            // الكاش فارغاً تماماً (لم تتم أي مزامنة من قبل) والحساب متصل.
            if (allRows.length === 0 && !forceRefresh) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    try {
                        console.log(`[GroupController] getGroupsByCategory: empty cache — auto-syncing account ${accountId}`);
                        await this._syncFromWhatsApp(accountId, sock, accountDB);
                        await CacheService.invalidateAccount(accountId);
                        allRows = await accountDB.all(`SELECT * FROM wa_groups ORDER BY members_count DESC`);
                    } catch (autoSyncErr) {
                        console.warn(`[GroupController] getGroupsByCategory: auto-sync failed for ${accountId}:`, autoSyncErr.message);
                    }
                }
            }

            const all = allRows.map(r => this._formatGroup(r));

            const members    = all.filter(g => g.is_member);
            const nonMembers = all.filter(g => !g.is_member);

            const publishable    = members.filter(g => g.publish_status === 'green');
            const restricted     = members.filter(g => g.publish_status === 'yellow');
            const nonPublishable = members.filter(g => g.publish_status === 'red');

            const stats = this._buildStats(members);

            console.log(`[GroupController] getGroupsByCategory: account ${accountId} — total=${members.length} publishable=${publishable.length} restricted=${restricted.length} nonPublishable=${nonPublishable.length}`);

            const categories = {
                publishable:    { label: 'قابلة للنشر',  count: publishable.length,    groups: publishable    },
                restricted:     { label: 'مقيدة',         count: restricted.length,     groups: restricted     },
                nonPublishable: { label: 'غير قابلة',     count: nonPublishable.length, groups: nonPublishable },
                archived:       { label: 'مؤرشفة',        count: nonMembers.length,     groups: nonMembers     },
            };

            const categoryStats = {
                total:          members.length,
                publishable:    publishable.length,
                restricted:     restricted.length,
                nonPublishable: nonPublishable.length,
                archived:       nonMembers.length,
                asAdmin:        stats.asAdmin,
                totalMembers:   stats.members,
                avgActivity:    stats.avgActivity,
            };

            const fullResponse = {
                success:    true,
                categories,
                stats:      categoryStats,
                can_publish:  publishable,
                restricted:   restricted,
                blocked:      nonPublishable,
                non_members:  nonMembers,
                total_members: members.length,
            };

            // حفظ في Redis
            await CacheService.set(cacheKey, { ...fullResponse, members }, CacheService.TTL.CATEGORIES);

            const paginatedMember = members.slice(offset, offset + limit);
            return res.json({
                ...fullResponse,
                members:    paginatedMember,
                pagination: this._buildPagination(page, limit, members.length),
            });

        } catch (error) {
            console.error('[GroupController] getGroupsByCategory Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── POST /accounts/:accountId/groups/sync ────────────────────────────────
    async syncGroups(req, res) {
        try {
            const { accountId } = req.params;
            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);
            await this._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]

            const groups = await this._syncFromWhatsApp(accountId, sock, accountDB);

            await accountDB.run(
                `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`,
                [accountId]
            ).catch(() => {});

            await CacheService.invalidateAccount(accountId);

            console.log(`[GroupController] syncGroups: ✅ synced ${groups.length} groups for account ${accountId}`);

            return res.json({
                success:   true,
                groups,
                count:     groups.length,
                synced_at: new Date().toISOString(),
            });
        } catch (error) {
            console.error('[GroupController] syncGroups Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:accountId/groups/sync-settings ────────────────────────
    async getSyncSettings(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]

            let settings = await accountDB.get(
                `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
            );

            if (!settings) {
                await accountDB.run(
                    `INSERT INTO group_sync_settings (account_id) VALUES ($1) ON CONFLICT DO NOTHING`,
                    [accountId]
                );
                settings = await accountDB.get(
                    `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
                );
            }

            res.json({ success: true, settings });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── PUT /accounts/:accountId/groups/sync-settings ────────────────────────
    async updateSyncSettings(req, res) {
        try {
            const { accountId } = req.params;
            const { interval_minutes, auto_sync_enabled } = req.body;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSyncSettingsTable(accountDB, accountId); // [FIX-ROOT-1]

            await accountDB.run(
                `UPDATE group_sync_settings
                 SET interval_minutes = $1, auto_sync_enabled = $2, updated_at = NOW()
                 WHERE account_id = $3`,
                [interval_minutes || 15, !!auto_sync_enabled, accountId]
            );

            const updated = await accountDB.get(
                `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
            );

            res.json({ success: true, settings: updated });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /groups/live ──────────────────────────────────────────────────
    // [FIX-ROOT-2] يُعيد publishable_count في summary
    async getLiveOverview(req, res) {
        try {
            const forceRefresh = req.query.refresh === '1';
            const accountsList = await listUserAccounts(req);

            console.log(`[GroupController] getLiveOverview: processing ${accountsList.length} accounts, forceRefresh=${forceRefresh}`);

            const results = await Promise.allSettled(accountsList.map(async (acc) => {
                const accountDB = await DatabaseManager.getAccountDB(acc.id);
                await this._ensureGroupsTable(accountDB);
                await this._ensureSyncSettingsTable(accountDB, acc.id); // [FIX-ROOT-1]

                const sock     = WhatsAppManager.getSession(acc.id);
                const isOnline = !!sock;
                const accountMeta = {
                    id: acc.id, name: acc.name, phone_number: acc.phone_number,
                    status: acc.status, is_online: isOnline,
                };

                if (!isOnline) {
                    const { groups, total } = await this._getCachedGroupsPaginated(accountDB, 500, 0);
                    const publishable = groups.filter(g => g.publish_status === 'green').length;
                    console.log(`[GroupController] getLiveOverview: account ${acc.id} offline — DB has ${total} groups (${publishable} publishable)`);
                    return {
                        account: accountMeta,
                        sync_available: false,
                        message: 'الحساب غير متصل بواتساب — تعذّر جلب بيانات حيّة، يُعرض آخر بيانات محفوظة.',
                        groups, groups_count: total,
                        publishable_count: publishable,
                        last_sync: groups[0]?.last_sync || null,
                    };
                }

                const settings = await accountDB.get(
                    `SELECT last_auto_sync FROM group_sync_settings WHERE account_id = $1`, [acc.id]
                ).catch(() => null);
                const lastSyncMs = settings?.last_auto_sync ? new Date(settings.last_auto_sync).getTime() : 0;
                const isFresh = !forceRefresh && (Date.now() - lastSyncMs) < LIVE_FRESHNESS_WINDOW_MS;

                if (isFresh) {
                    const { groups, total } = await this._getCachedGroupsPaginated(accountDB, 500, 0);
                    const publishable = groups.filter(g => g.publish_status === 'green').length;
                    console.log(`[GroupController] getLiveOverview: account ${acc.id} fresh cache — ${total} groups (${publishable} publishable)`);
                    return {
                        account: accountMeta,
                        sync_available: true,
                        from_cache: true,
                        groups, groups_count: total,
                        publishable_count: publishable,
                        last_sync: settings?.last_auto_sync || null,
                    };
                }

                // جلب حي من Baileys
                try {
                    const groups = await withTimeout(
                        this._syncFromWhatsApp(acc.id, sock, accountDB),
                        LIVE_SYNC_TIMEOUT_MS
                    );
                    await accountDB.run(
                        `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`, [acc.id]
                    ).catch(() => {});
                    await CacheService.invalidateAccount(acc.id);

                    const publishable = groups.filter(g => g.publish_status === 'green').length;
                    const restricted  = groups.filter(g => g.publish_status === 'yellow').length;
                    console.log(`[GroupController] getLiveOverview: account ${acc.id} live sync — ${groups.length} groups (${publishable} publishable, ${restricted} restricted)`);

                    return {
                        account: accountMeta,
                        sync_available: true,
                        groups, groups_count: groups.length,
                        publishable_count: publishable,
                        last_sync: new Date().toISOString(),
                    };
                } catch (err) {
                    const { groups, total } = await this._getCachedGroupsPaginated(accountDB, 500, 0);
                    const publishable = groups.filter(g => g.publish_status === 'green').length;
                    console.warn(`[GroupController] getLiveOverview: account ${acc.id} sync failed (${err.message}) — fallback to DB (${total} groups)`);
                    return {
                        account: accountMeta,
                        sync_available: true,
                        warning: err.message === 'TIMEOUT'
                            ? 'استغرقت المزامنة الحيّة وقتاً طويلاً — يُعرض آخر بيانات محفوظة.'
                            : `فشلت المزامنة الحيّة: ${err.message}`,
                        groups, groups_count: total,
                        publishable_count: publishable,
                        last_sync: groups[0]?.last_sync || null,
                    };
                }
            }));

            const accountsBreakdown = [];
            const allGroups = [];
            let totalPublishable = 0;
            let totalRestricted  = 0;
            let totalNonPublish  = 0;

            for (const r of results) {
                if (r.status !== 'fulfilled') continue;
                const v = r.value;
                accountsBreakdown.push({
                    ...v.account,
                    sync_available:   v.sync_available,
                    message:          v.message || v.warning || null,
                    groups_count:     v.groups_count,
                    publishable_count: v.publishable_count || 0,
                    last_sync:        v.last_sync,
                    from_cache:       !!v.from_cache,
                });
                for (const g of v.groups) {
                    allGroups.push({ ...g, account: v.account });
                }
                totalPublishable += v.publishable_count || 0;
                totalRestricted  += v.groups.filter(g => g.publish_status === 'yellow').length;
                totalNonPublish  += v.groups.filter(g => g.publish_status === 'red').length;
            }

            allGroups.sort((a, b) => b.members_count - a.members_count);

            console.log(`[GroupController] getLiveOverview: DONE — total_groups=${allGroups.length} publishable=${totalPublishable} restricted=${totalRestricted} non_publishable=${totalNonPublish}`);

            return res.json({
                success: true,
                generated_at: new Date().toISOString(),
                summary: {
                    total_accounts:    accountsBreakdown.length,
                    online_accounts:   accountsBreakdown.filter(a => a.is_online).length,
                    offline_accounts:  accountsBreakdown.filter(a => !a.is_online).length,
                    total_groups:      allGroups.length,
                    total_members:     allGroups.reduce((s, g) => s + (g.members_count || 0), 0),
                    // [FIX-ROOT-2] أعداد النشر في الـ summary
                    publishable_count: totalPublishable,
                    restricted_count:  totalRestricted,
                    non_publish_count: totalNonPublish,
                },
                accounts: accountsBreakdown,
                groups:   allGroups,
            });
        } catch (error) {
            console.error('[GroupController] getLiveOverview Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── POST /groups/sync-all ────────────────────────────────────────────
    async syncAllAccounts(req, res) {
        try {
            const accountsList = await listUserAccounts(req);

            const perAccount = await Promise.allSettled(accountsList.map(async (acc) => {
                const sock = WhatsAppManager.getSession(acc.id);

                if (!sock) {
                    SocketBridge.emit('groups:sync_progress', {
                        accountId: acc.id, accountName: acc.name, status: 'unavailable',
                        message: 'الحساب غير متصل بواتساب — تعذّرت المزامنة لهذا الحساب.',
                    });
                    return {
                        account_id: acc.id, name: acc.name, status: 'unavailable',
                        message: 'الحساب غير متصل بواتساب — تعذّرت المزامنة لهذا الحساب.',
                    };
                }

                SocketBridge.emit('groups:sync_progress', {
                    accountId: acc.id, accountName: acc.name, status: 'syncing',
                });

                const accountDB = await DatabaseManager.getAccountDB(acc.id);
                await this._ensureGroupsTable(accountDB);
                await this._ensureSyncSettingsTable(accountDB, acc.id); // [FIX-ROOT-1]

                const beforeRows = await accountDB.all(
                    `SELECT group_jid FROM wa_groups WHERE is_member = TRUE`
                );
                const beforeSet = new Set(beforeRows.map(r => r.group_jid));

                try {
                    const groups = await withTimeout(
                        this._syncFromWhatsApp(acc.id, sock, accountDB),
                        SYNC_ALL_TIMEOUT_MS
                    );
                    await accountDB.run(
                        `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`, [acc.id]
                    ).catch(() => {});
                    await CacheService.invalidateAccount(acc.id);

                    const afterSet = new Set(groups.map(g => g.group_jid));
                    const added    = [...afterSet].filter(j => !beforeSet.has(j)).length;
                    const removed  = [...beforeSet].filter(j => !afterSet.has(j)).length;
                    const updated  = groups.length - added;
                    const publishable = groups.filter(g => g.publish_status === 'green').length;

                    console.log(`[GroupController] syncAllAccounts: ✅ account ${acc.id} — discovered=${groups.length} added=${added} publishable=${publishable}`);

                    SocketBridge.emit('groups:sync_progress', {
                        accountId: acc.id, accountName: acc.name, status: 'done',
                        discovered: groups.length, added, updated, removed, publishable,
                    });

                    return {
                        account_id: acc.id, name: acc.name, status: 'done',
                        discovered: groups.length, added, updated, removed, publishable,
                        synced_at: new Date().toISOString(),
                    };
                } catch (err) {
                    const message = err.message === 'TIMEOUT' ? 'انتهت مهلة المزامنة' : err.message;
                    SocketBridge.emit('groups:sync_progress', {
                        accountId: acc.id, accountName: acc.name, status: 'error', message,
                    });
                    return { account_id: acc.id, name: acc.name, status: 'error', message };
                }
            }));

            const summary = perAccount.map(r =>
                r.status === 'fulfilled' ? r.value : { status: 'error', message: r.reason?.message }
            );

            SocketBridge.emit('groups:sync_complete', { summary, finished_at: new Date().toISOString() });

            return res.json({
                success: true,
                finished_at: new Date().toISOString(),
                accounts: summary,
                totals: {
                    synced:      summary.filter(s => s.status === 'done').length,
                    unavailable: summary.filter(s => s.status === 'unavailable').length,
                    failed:      summary.filter(s => s.status === 'error').length,
                    discovered:  summary.reduce((s, a) => s + (a.discovered || 0), 0),
                    publishable: summary.reduce((s, a) => s + (a.publishable || 0), 0),
                },
            });
        } catch (error) {
            console.error('[GroupController] syncAllAccounts Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ════════════════════════════════════════════════════════════════════════
    // Private Helpers
    // ════════════════════════════════════════════════════════════════════════

    async _getCachedGroupsPaginated(accountDB, limit, offset) {
        const [rows, countRow] = await Promise.all([
            accountDB.all(
                `SELECT * FROM wa_groups WHERE is_member = TRUE
                 ORDER BY members_count DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            accountDB.get(`SELECT COUNT(*) as cnt FROM wa_groups WHERE is_member = TRUE`),
        ]);
        return {
            groups: rows.map(r => this._formatGroup(r)),
            total:  parseInt(countRow?.cnt || 0),
        };
    }

    // [FIX-ROOT-4] logs تفصيلية في كل مرحلة
    // [FIX-ROOT-6] استخدام مطابقة LID/PN الصحيحة بدل المطابقة المباشرة
    async _syncFromWhatsApp(accountId, sock, accountDB) {
        console.log(`[GroupController] _syncFromWhatsApp: START — account ${accountId}`);

        const raw   = await sock.groupFetchAllParticipating();
        const selfIds = _selfIdentifiers(sock);

        console.log(`[GroupController] _syncFromWhatsApp: WhatsApp returned ${Object.keys(raw).length} raw entries for account ${accountId}`);
        console.log(`[GroupController] _syncFromWhatsApp: self identifiers — ${[...selfIds].join(', ') || '(none found)'}`);

        const groups         = [];
        const activeGroupIds = new Set();
        const batchRows      = [];
        let   skippedNonGroup = 0;

        for (const [jid, meta] of Object.entries(raw)) {
            if (!jid.endsWith('@g.us')) { skippedNonGroup++; continue; }
            activeGroupIds.add(jid);

            const myParticipant = _findSelfParticipant(meta.participants, selfIds);

            // [FIX] isMember دائماً true — groupFetchAllParticipating تُعيد فقط المجموعات التي أنت عضو فيها
            const isMember   = true;
            const isAdmin    = myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin';
            const announce   = !!meta.announce;
            const canPublish = !announce || isAdmin;

            const canSendText   = canPublish;
            const canSendImages = canPublish;
            const canSendVideo  = canPublish;
            const canSendFiles  = canPublish;
            const canSendLinks  = canPublish;
            const canBroadcast  = isAdmin;

            let publishStatus;
            if (!announce)    publishStatus = 'green';
            else if (isAdmin) publishStatus = 'yellow';
            else              publishStatus = 'red';

            const avatarUrl    = null;
            const membersCount = meta.participants?.length || 0;
            const adminsCount  = meta.participants?.filter(p => p.admin).length || 0;
            const activityLevel = this._estimateActivity(meta);

            batchRows.push([
                uuidv4(), jid,
                meta.subject || 'مجموعة بدون اسم',
                meta.desc    || '',
                meta.owner   || '',
                membersCount, adminsCount,
                announce, !!meta.restrict,
                meta.creation || 0,
                avatarUrl,
                isMember, isAdmin,
                publishStatus,
                canSendText, canSendImages, canSendVideo,
                canSendFiles, canSendLinks, canBroadcast,
                activityLevel,
                new Date().toISOString(),
            ]);

            groups.push({
                id:              jid,
                group_jid:       jid,
                name:            meta.subject || 'مجموعة بدون اسم',
                description:     meta.desc    || '',
                owner:           meta.owner   || '',
                members_count:   membersCount,
                admins_count:    adminsCount,
                announce,
                restrict:        !!meta.restrict,
                creation_ts:     meta.creation || 0,
                avatar_url:      avatarUrl,
                is_member:       isMember,
                is_admin:        isAdmin,
                publish_status:  publishStatus,
                can_send_text:   canSendText,
                can_send_images: canSendImages,
                can_send_video:  canSendVideo,
                can_send_files:  canSendFiles,
                can_send_links:  canSendLinks,
                can_broadcast:   canBroadcast,
                activity_level:  activityLevel,
                messages_today:  0,
                last_sync:       new Date().toISOString(),
            });
        }

        const publishable = groups.filter(g => g.publish_status === 'green').length;
        const restricted  = groups.filter(g => g.publish_status === 'yellow').length;
        const nonPublish  = groups.filter(g => g.publish_status === 'red').length;

        console.log(`[GroupController] _syncFromWhatsApp: parsed ${groups.length} groups (skipped ${skippedNonGroup} non-group entries)`);
        console.log(`[GroupController] _syncFromWhatsApp: publish breakdown — green=${publishable} yellow=${restricted} red=${nonPublish} — account ${accountId}`);

        // Batch UPSERT
        const CHUNK_SIZE = 50;
        for (let i = 0; i < batchRows.length; i += CHUNK_SIZE) {
            const chunk = batchRows.slice(i, i + CHUNK_SIZE);
            await this._batchUpsertGroups(accountDB, chunk);
        }

        console.log(`[GroupController] _syncFromWhatsApp: ✅ saved ${batchRows.length} groups to DB for account ${accountId}`);

        // تحديث المجموعات التي خرج منها الحساب
        if (activeGroupIds.size > 0) {
            const ids = Array.from(activeGroupIds);
            const ph  = ids.map((_, idx) => `$${idx + 1}`).join(',');
            const result = await accountDB.run(
                `UPDATE wa_groups SET is_member = FALSE WHERE group_jid NOT IN (${ph})`, ids
            ).catch(() => null);
            if (result) {
                console.log(`[GroupController] _syncFromWhatsApp: marked old groups as non-member for account ${accountId}`);
            }
        }

        // التحقق من الحفظ الفعلي
        const savedCount = await accountDB.get(`SELECT COUNT(*) as cnt FROM wa_groups WHERE is_member = TRUE`).catch(() => ({ cnt: 0 }));
        console.log(`[GroupController] _syncFromWhatsApp: DB verification — ${savedCount?.cnt || 0} is_member=TRUE rows for account ${accountId}`);

        return groups.sort((a, b) => b.members_count - a.members_count);
    }

    async _batchUpsertGroups(accountDB, rows) {
        if (!rows.length) return;

        const cols = [
            'id', 'group_jid', 'name', 'description', 'owner',
            'members_count', 'admins_count', 'announce', 'restrict_mode',
            'creation_ts', 'avatar_url', 'is_member', 'is_admin', 'publish_status',
            'can_send_text', 'can_send_images', 'can_send_video',
            'can_send_files', 'can_send_links', 'can_broadcast',
            'activity_level', 'last_sync',
        ];

        const rowsSQL  = [];
        const params   = [];
        let   paramIdx = 1;

        for (const row of rows) {
            const placeholders = row.map(() => `$${paramIdx++}`);
            rowsSQL.push(`(${placeholders.join(',')})`);
            params.push(...row);
        }

        const updateCols = [
            'name', 'description', 'owner', 'members_count', 'admins_count',
            'announce', 'restrict_mode', 'avatar_url', 'is_member', 'is_admin',
            'publish_status', 'can_send_text', 'can_send_images', 'can_send_video',
            'can_send_files', 'can_send_links', 'can_broadcast', 'activity_level', 'last_sync',
        ].map(c => `${c} = EXCLUDED.${c}`).join(', ');

        const sql = `
            INSERT INTO wa_groups (${cols.join(',')})
            VALUES ${rowsSQL.join(',\n')}
            ON CONFLICT (group_jid) DO UPDATE SET ${updateCols}
        `;

        await accountDB.run(sql, params);
    }

    _estimateActivity(meta) {
        const memberCount = meta.participants?.length || 1;
        const adminCount  = meta.participants?.filter(p => p.admin).length || 0;
        const isAnnounce  = !!meta.announce;
        const ageInDays   = meta.creation
            ? (Date.now() / 1000 - meta.creation) / 86400 : 365;

        let score = 50;
        if (memberCount > 500)      score += 30;
        else if (memberCount > 200) score += 20;
        else if (memberCount > 100) score += 12;
        else if (memberCount > 50)  score +=  6;
        else if (memberCount < 10)  score -= 15;
        if (isAnnounce)             score -= 20;
        if (adminCount > 5)         score +=  8;
        if (ageInDays < 30)         score += 15;
        else if (ageInDays > 730)   score -= 10;
        return Math.max(5, Math.min(98, score));
    }

    async _ensureGroupsTable(accountDB) {
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS wa_groups (
                id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
                group_jid       TEXT UNIQUE NOT NULL,
                name            TEXT DEFAULT '',
                description     TEXT DEFAULT '',
                owner           TEXT DEFAULT '',
                members_count   INTEGER DEFAULT 0,
                admins_count    INTEGER DEFAULT 0,
                announce        BOOLEAN DEFAULT FALSE,
                restrict_mode   BOOLEAN DEFAULT FALSE,
                creation_ts     BIGINT  DEFAULT 0,
                avatar_url      TEXT,
                is_member       BOOLEAN DEFAULT TRUE,
                is_admin        BOOLEAN DEFAULT FALSE,
                publish_status  TEXT DEFAULT 'green',
                can_send_text   BOOLEAN DEFAULT TRUE,
                can_send_images BOOLEAN DEFAULT TRUE,
                can_send_video  BOOLEAN DEFAULT TRUE,
                can_send_files  BOOLEAN DEFAULT TRUE,
                can_send_links  BOOLEAN DEFAULT TRUE,
                can_broadcast   BOOLEAN DEFAULT FALSE,
                activity_level  INTEGER DEFAULT 50,
                messages_today  INTEGER DEFAULT 0,
                last_sync       TIMESTAMP DEFAULT NOW(),
                created_at      TIMESTAMP DEFAULT NOW()
            )
        `);
    }

    // [FIX-ROOT-1] يستقبل accountId ويُدخله بدلاً من 'default'
    async _ensureSyncSettingsTable(accountDB, accountId) {
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS group_sync_settings (
                account_id        TEXT PRIMARY KEY,
                interval_minutes  INTEGER  DEFAULT 15,
                auto_sync_enabled BOOLEAN  DEFAULT TRUE,
                last_auto_sync    TIMESTAMP,
                created_at        TIMESTAMP DEFAULT NOW(),
                updated_at        TIMESTAMP DEFAULT NOW()
            )
        `);

        // إدخال صف بـ accountId الحقيقي (لا 'default')
        if (accountId && accountId !== 'default') {
            await accountDB.run(`
                INSERT INTO group_sync_settings (account_id)
                VALUES ($1)
                ON CONFLICT (account_id) DO NOTHING
            `, [accountId]).catch(() => {});
        }
    }

    async _ensureExclusionsTable(accountDB) {
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS member_exclusions (
                id         TEXT PRIMARY KEY,
                account_id TEXT NOT NULL,
                phone      TEXT NOT NULL,
                note       TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(account_id, phone)
            )
        `);
    }

    _buildPagination(page, limit, total) {
        return {
            page,
            limit,
            total,
            pages:    Math.ceil(total / limit),
            has_next: page * limit < total,
            has_prev: page > 1,
        };
    }

    _buildStats(groups) {
        const total       = groups.length;
        const canPublish  = groups.filter(g => g.publish_status === 'green').length;
        const restricted  = groups.filter(g => g.publish_status === 'yellow').length;
        const blocked     = groups.filter(g => g.publish_status === 'red').length;
        const asAdmin     = groups.filter(g => g.is_admin).length;
        const members     = groups.reduce((s, g) => s + (g.members_count || 0), 0);
        const avgActivity = total
            ? Math.round(groups.reduce((s, g) => s + (g.activity_level || 0), 0) / total) : 0;
        return { total, canPublish, restricted, blocked, asAdmin, members, avgActivity };
    }

    _formatGroup(row) {
        return {
            id:              row.id,
            group_jid:       row.group_jid,
            name:            row.name            || 'مجموعة',
            description:     row.description     || '',
            owner:           row.owner           || '',
            members_count:   Number(row.members_count)   || 0,
            admins_count:    Number(row.admins_count)    || 0,
            announce:        Boolean(row.announce),
            restrict:        Boolean(row.restrict_mode),
            creation_ts:     Number(row.creation_ts)    || 0,
            avatar_url:      row.avatar_url      || null,
            is_member:       Boolean(row.is_member),
            is_admin:        Boolean(row.is_admin),
            publish_status:  row.publish_status  || 'green',
            can_send_text:   Boolean(row.can_send_text),
            can_send_images: Boolean(row.can_send_images),
            can_send_video:  Boolean(row.can_send_video),
            can_send_files:  Boolean(row.can_send_files),
            can_send_links:  Boolean(row.can_send_links),
            can_broadcast:   Boolean(row.can_broadcast),
            activity_level:  Number(row.activity_level)  || 50,
            messages_today:  Number(row.messages_today)  || 0,
            last_sync:       row.last_sync       || null,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // الجزء الخامس — نشر لأعضاء المجموعات
    // ════════════════════════════════════════════════════════════════════════

    async getMembersForPublish(req, res) {
        try {
            const { accountId } = req.params;
            const { group_jids, exclude_admins, excluded_numbers } = req.body;

            if (!group_jids || group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const excludedSet = new Set((excluded_numbers || []).map(n =>
                n.toString().replace(/[^0-9]/g, '') + '@s.whatsapp.net'
            ));

            const allTargets = [];
            const seenJids   = new Set();
            const selfIds    = _selfIdentifiers(sock); // [FIX-ROOT-6]

            for (const groupJid of group_jids) {
                try {
                    const meta = await sock.groupMetadata(groupJid);
                    if (!meta?.participants) continue;

                    for (const p of meta.participants) {
                        const pJid = _normalizeJid(p.id);
                        if (seenJids.has(pJid)) continue;
                        if (exclude_admins && (p.admin === 'admin' || p.admin === 'superadmin')) continue;
                        if (excludedSet.has(pJid)) continue;
                        const pCandidates = [p.id, p.lid, p.phoneNumber, p.jid].map(_normalizeJid).filter(Boolean);
                        if (pCandidates.some(c => selfIds.has(c))) continue; // [FIX-ROOT-6] skip self via any identifier

                        seenJids.add(pJid);
                        allTargets.push({
                            jid:       pJid,
                            phone:     pJid.split('@')[0],
                            is_admin:  !!(p.admin),
                            group_jid: groupJid,
                        });
                    }
                } catch (e) {
                    console.warn(`[getMembersForPublish] skip ${groupJid}:`, e.message);
                }
            }

            res.json({ success: true, targets: allTargets, count: allTargets.length });
        } catch (err) {
            console.error('[GroupController] getMembersForPublish Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async publishToMembers(req, res) {
        try {
            const { accountId } = req.params;
            const {
                group_jids, account_ids, ad_library_id, custom_content,
                send_time, interval_seconds, exclude_admins, excluded_numbers,
            } = req.body;

            if (!group_jids || group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const crypto = require('crypto');
            const path   = require('path');
            const fs     = require('fs');

            const useAccountIds = (account_ids && account_ids.length > 0) ? account_ids : [accountId];
            const accountDB     = await DatabaseManager.getAccountDB(accountId);
            let messageContent  = custom_content || '';
            let mediaPaths      = [];

            if (ad_library_id) {
                const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [ad_library_id]);
                if (ad) {
                    messageContent = ad.content || messageContent;
                    mediaPaths     = JSON.parse(ad.media_paths || '[]');
                    await accountDB.run(
                        `UPDATE ad_library SET times_used = times_used + 1, last_used_at = NOW() WHERE id = $1`,
                        [ad_library_id]
                    );
                }
            }

            if (!messageContent && mediaPaths.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب إضافة نص أو وسائط للرسالة' });
            }

            const excludedSet = new Set((excluded_numbers || []).map(n =>
                n.toString().replace(/[^0-9]/g, '') + '@s.whatsapp.net'
            ));

            const allTargets = [];
            const seenJids   = new Set();

            for (const accId of useAccountIds) {
                const sock = WhatsAppManager.getSession(accId);
                if (!sock) continue;
                const selfIds = _selfIdentifiers(sock); // [FIX-ROOT-6]

                for (const groupJid of group_jids) {
                    try {
                        const meta = await sock.groupMetadata(groupJid);
                        if (!meta?.participants) continue;

                        for (const p of meta.participants) {
                            const pJid = _normalizeJid(p.id);
                            if (seenJids.has(pJid)) continue;
                            const pCandidates = [p.id, p.lid, p.phoneNumber, p.jid].map(_normalizeJid).filter(Boolean);
                            if (pCandidates.some(c => selfIds.has(c))) continue; // [FIX-ROOT-6] skip self via any identifier
                            if (exclude_admins && p.admin) continue;
                            if (excludedSet.has(pJid)) continue;

                            seenJids.add(pJid);
                            allTargets.push({ jid: pJid, accountId: accId, sock });
                        }
                    } catch (e) {
                        console.warn(`[publishToMembers] skip group ${groupJid}:`, e.message);
                    }
                }
            }

            if (allTargets.length === 0) {
                return res.status(400).json({ success: false, error: 'لا يوجد أعضاء مستهدفون' });
            }

            if (send_time && new Date(send_time) > new Date()) {
                const jobId = crypto.randomUUID();
                const sysDB = await DatabaseManager.getSystemDB();
                await sysDB.run(`
                    CREATE TABLE IF NOT EXISTS member_publish_jobs (
                        id TEXT PRIMARY KEY, account_id TEXT, targets TEXT,
                        message_content TEXT, media_paths TEXT, ad_library_id TEXT,
                        interval_seconds INTEGER DEFAULT 3, status TEXT DEFAULT 'pending',
                        scheduled_at TIMESTAMP, started_at TIMESTAMP, completed_at TIMESTAMP,
                        total_count INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0,
                        failed_count INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
                    )
                `).catch(() => {});

                await sysDB.run(`
                    INSERT INTO member_publish_jobs
                    (id, account_id, targets, message_content, media_paths, ad_library_id, interval_seconds, scheduled_at, total_count)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                `, [
                    jobId, accountId,
                    JSON.stringify(allTargets.map(t => ({ jid: t.jid, accountId: t.accountId }))),
                    messageContent, JSON.stringify(mediaPaths), ad_library_id || null,
                    interval_seconds || 3, send_time, allTargets.length,
                ]);

                return res.json({
                    success: true, scheduled: true, job_id: jobId, count: allTargets.length,
                    message: `✅ تم جدولة الإرسال لـ ${allTargets.length} عضو في ${new Date(send_time).toLocaleString('ar-SA')}`,
                });
            }

            const MEDIA_BASE = path.resolve(__dirname, '../../../../');
            const delay = ms => new Promise(r => setTimeout(r, ms));
            const intervalMs = (interval_seconds || 3) * 1000;

            const results = [];
            let sent = 0, failed = 0;

            for (const target of allTargets) {
                try {
                    if (mediaPaths.length > 0) {
                        const mediaPath = path.join(MEDIA_BASE, mediaPaths[0]);
                        if (fs.existsSync(mediaPath)) {
                            const buf = fs.readFileSync(mediaPath);
                            const ext = path.extname(mediaPaths[0]).toLowerCase();
                            if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) {
                                await target.sock.sendMessage(target.jid, { image: buf, caption: messageContent });
                            } else if (['.mp4','.mov','.avi'].includes(ext)) {
                                await target.sock.sendMessage(target.jid, { video: buf, caption: messageContent });
                            } else {
                                await target.sock.sendMessage(target.jid, {
                                    document: buf, caption: messageContent,
                                    fileName: path.basename(mediaPaths[0]),
                                });
                            }
                        } else {
                            await target.sock.sendMessage(target.jid, { text: messageContent });
                        }
                    } else {
                        await target.sock.sendMessage(target.jid, { text: messageContent });
                    }
                    results.push({ jid: target.jid, status: 'sent' });
                    sent++;
                } catch (e) {
                    results.push({ jid: target.jid, status: 'failed', error: e.message });
                    failed++;
                }
                await delay(intervalMs);
            }

            const logId = crypto.randomUUID();
            await accountDB.run(`
                CREATE TABLE IF NOT EXISTS member_publish_log (
                    id TEXT PRIMARY KEY, account_id TEXT, ad_library_id TEXT,
                    group_jids TEXT, excluded_numbers TEXT, exclude_admins BOOLEAN DEFAULT FALSE,
                    total_targets INTEGER DEFAULT 0, sent_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0,
                    message_content TEXT, status TEXT DEFAULT 'completed', created_at TIMESTAMP DEFAULT NOW()
                )
            `).catch(() => {});

            await accountDB.run(`
                INSERT INTO member_publish_log
                (id, account_id, ad_library_id, group_jids, excluded_numbers, exclude_admins, total_targets, sent_count, failed_count, message_content, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [
                logId, accountId, ad_library_id || null,
                JSON.stringify(group_jids), JSON.stringify(excluded_numbers || []),
                !!exclude_admins, allTargets.length, sent, failed,
                messageContent, failed === 0 ? 'completed' : 'partial',
            ]).catch(() => {});

            res.json({
                success: true,
                message: `✅ تم الإرسال لـ ${sent} من ${allTargets.length} عضو`,
                sent, failed, total: allTargets.length, results,
            });

        } catch (err) {
            console.error('[GroupController] publishToMembers Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async getExclusions(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureExclusionsTable(accountDB);
            const rows = await accountDB.all(
                `SELECT * FROM member_exclusions WHERE account_id = $1 ORDER BY created_at DESC`,
                [accountId]
            );
            res.json({ success: true, exclusions: rows });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async addExclusions(req, res) {
        try {
            const { accountId } = req.params;
            const { numbers, note } = req.body;
            if (!numbers || numbers.length === 0) {
                return res.status(400).json({ success: false, error: 'لا توجد أرقام' });
            }
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureExclusionsTable(accountDB);
            const crypto = require('crypto');
            let added = 0;
            for (const num of numbers) {
                const clean = num.toString().replace(/[^0-9]/g, '');
                if (!clean) continue;
                await accountDB.run(
                    `INSERT INTO member_exclusions (id, account_id, phone, note)
                     VALUES ($1,$2,$3,$4) ON CONFLICT (account_id, phone) DO NOTHING`,
                    [crypto.randomUUID(), accountId, clean, note || '']
                ).catch(() => {});
                added++;
            }
            res.json({ success: true, added, message: `✅ تم إضافة ${added} رقم للاستثناء` });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async deleteExclusion(req, res) {
        try {
            const { accountId, exclusionId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `DELETE FROM member_exclusions WHERE id = $1 AND account_id = $2`,
                [exclusionId, accountId]
            );
            res.json({ success: true, message: 'تم حذف الرقم من الاستثناءات' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async clearExclusions(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `DELETE FROM member_exclusions WHERE account_id = $1`, [accountId]
            );
            res.json({ success: true, message: 'تم مسح قائمة الاستثناءات' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async exportMembers(req, res) {
        try {
            const { accountId, groupId } = req.params;
            const format = req.query.format || 'csv';
            const jid    = decodeURIComponent(groupId);

            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const meta = await sock.groupMetadata(jid);
            if (!meta) return res.status(404).json({ success: false, error: 'المجموعة غير موجودة' });

            const groupName   = meta.subject || 'group';
            const extractedAt = new Date().toISOString();
            const members     = (meta.participants || []).map(p => ({
                phone:        p.id.replace(/:\d+@.*/, '').replace(/@.*/, ''),
                jid:          p.id,
                role:         p.admin === 'superadmin' ? 'مشرف رئيسي' : p.admin === 'admin' ? 'مشرف' : 'عضو',
                group_name:   groupName,
                extracted_at: extractedAt,
            }));

            if (format === 'json') {
                return res.json({ success: true, group_name: groupName, count: members.length, members });
            }
            if (format === 'txt') {
                const txt = members.map(m => m.phone).join('\n');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="${groupName}_members.txt"`);
                return res.send(txt);
            }
            const csvRows = ['phone,jid,role,group_name,extracted_at'];
            for (const m of members) {
                csvRows.push(`${m.phone},${m.jid},${m.role},${m.group_name},${m.extracted_at}`);
            }
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${groupName}_members.csv"`);
            return res.send('\uFEFF' + csvRows.join('\n'));

        } catch (err) {
            console.error('[GroupController] exportMembers Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    async getGroupMembers(req, res) {
        try {
            const { accountId, groupId } = req.params;
            const page  = parseInt(req.query.page)  || 1;
            const limit = parseInt(req.query.limit) || 50;
            const offset = (page - 1) * limit;

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const members = await accountDB.all(
                `SELECT * FROM group_members WHERE group_id = ? ORDER BY name ASC LIMIT ? OFFSET ?`,
                [groupId, limit, offset]
            ).catch(() => []);
            const total = await accountDB.get(
                `SELECT COUNT(*) as count FROM group_members WHERE group_id = ?`, [groupId]
            ).catch(() => ({ count: 0 }));

            return res.json({ success: true, members, total: total?.count || 0, page, limit });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    async exportMultipleGroupsMembers(req, res) {
        try {
            const { accountId } = req.params;
            const { groupIds } = req.body || {};
            if (!groupIds || !Array.isArray(groupIds)) {
                return res.status(400).json({ success: false, error: 'groupIds مطلوب' });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const rows = [];
            for (const gId of groupIds) {
                const members = await accountDB.all(
                    `SELECT gm.*, g.name as group_name FROM group_members gm
                     LEFT JOIN groups g ON g.id = gm.group_id
                     WHERE gm.group_id = ?`, [gId]
                ).catch(() => []);
                rows.push(...members);
            }

            const header = 'Group,Name,Phone,Admin';
            const csvRows = [header, ...rows.map(m =>
                `"${m.group_name||''}","${m.name||''}","${m.phone||m.id||''}","${m.is_admin?'Yes':'No'}"`
            )];

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename="members_export.csv"');
            return res.send('\uFEFF' + csvRows.join('\n'));
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }

    async getSavedMembers(req, res) {
        try {
            const { accountId } = req.params;
            const page  = parseInt(req.query.page)  || 1;
            const limit = parseInt(req.query.limit) || 50;
            const offset = (page - 1) * limit;

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const members = await accountDB.all(
                `SELECT * FROM group_members ORDER BY name ASC LIMIT ? OFFSET ?`,
                [limit, offset]
            ).catch(() => []);

            return res.json({ success: true, members, page, limit });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    }
}

module.exports = new GroupController();
