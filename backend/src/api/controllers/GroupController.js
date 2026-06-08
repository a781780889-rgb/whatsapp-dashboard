'use strict';
/**
 * GroupController — مجموعات واتساب الحقيقية
 * النسخة المحدّثة: مزامنة تلقائية + حفظ دائم + إعدادات الفاصل الزمني
 * + تصنيف المجموعات: قابلة للنشر / مقيدة / غير قابلة / مؤرشفة
 */
const WhatsAppManager = require('../../bot/WhatsAppManager');
const DatabaseManager = require('../../database/DatabaseManager');
const { v4: uuidv4 } = require('uuid');

class GroupController {

    // ── GET /accounts/:accountId/groups ────────────────────────────────────────
    async getGroups(req, res) {
        try {
            const { accountId } = req.params;
            const forceRefresh  = req.query.refresh === '1';

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);
            await this._ensureSyncSettingsTable(accountDB);

            // فرض تحديث من واتساب
            if (forceRefresh) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    const synced = await this._syncFromWhatsApp(accountId, sock, accountDB);
                    await accountDB.run(
                        `UPDATE group_sync_settings SET last_auto_sync = NOW() WHERE account_id = $1`,
                        [accountId]
                    ).catch(() => {});
                    return res.json({
                        success:   true,
                        groups:    synced,
                        count:     synced.length,
                        source:    'whatsapp',
                        synced_at: new Date().toISOString(),
                    });
                }
                // لا يوجد اتصال — إرجاع الكاش مع تحذير
                const cached2 = await this._getCachedGroups(accountDB);
                return res.json({
                    success:   true,
                    groups:    cached2,
                    count:     cached2.length,
                    source:    'cache',
                    synced_at: cached2[0]?.last_sync || null,
                    warning:   'جلسة واتساب غير متصلة — يُعرض الكاش المحفوظ.',
                });
            }

            // القراءة من الكاش دائماً (سريع — بدون استدعاء واتساب)
            const cached = await this._getCachedGroups(accountDB);
            const settings = await accountDB.get(
                `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
            );

            return res.json({
                success:         true,
                groups:          cached,
                count:           cached.length,
                source:          'cache',
                synced_at:       cached[0]?.last_sync || null,
                sync_settings:   settings ? {
                    interval_minutes:  settings.interval_minutes,
                    auto_sync_enabled: settings.auto_sync_enabled,
                    last_auto_sync:    settings.last_auto_sync,
                } : null,
            });

        } catch (error) {
            console.error('[GroupController] getGroups Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:accountId/groups/categories ─────────────────────────────
    // الجزء الثاني: تصنيف المجموعات بشكل كامل
    async getGroupsByCategory(req, res) {
        try {
            const { accountId } = req.params;
            const forceRefresh  = req.query.refresh === '1';

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);
            await this._ensureSyncSettingsTable(accountDB);

            // إذا طُلب تحديث — زامن أولاً
            if (forceRefresh) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    await this._syncFromWhatsApp(accountId, sock, accountDB);
                }
            }

            // ── جلب كل المجموعات (أعضاء وغير أعضاء) ──
            const allRows = await accountDB.all(
                `SELECT * FROM wa_groups ORDER BY members_count DESC`
            );
            const all = allRows.map(r => this._formatGroup(r));

            // ── تصنيف المجموعات ──
            const publishable   = all.filter(g => g.is_member && g.publish_status === 'green');
            const restricted    = all.filter(g => g.is_member && g.publish_status === 'yellow');
            const nonPublishable = all.filter(g => g.is_member && g.publish_status === 'red');
            const archived      = all.filter(g => !g.is_member); // خرج منها أو مؤرشفة

            // ── إحصائيات ──
            const stats = {
                total:          all.length,
                publishable:    publishable.length,
                restricted:     restricted.length,
                nonPublishable: nonPublishable.length,
                archived:       archived.length,
                asAdmin:        all.filter(g => g.is_admin).length,
                totalMembers:   all.reduce((s, g) => s + (g.members_count || 0), 0),
                avgActivity:    all.length
                    ? Math.round(all.reduce((s, g) => s + (g.activity_level || 0), 0) / all.length) : 0,
            };

            res.json({
                success: true,
                stats,
                categories: {
                    publishable:    { label: 'قابلة للنشر',     count: publishable.length,    groups: publishable    },
                    restricted:     { label: 'مقيدة (مشرف فقط)', count: restricted.length,    groups: restricted    },
                    nonPublishable: { label: 'غير قابلة للنشر', count: nonPublishable.length, groups: nonPublishable },
                    archived:       { label: 'مؤرشفة',          count: archived.length,       groups: archived      },
                },
                synced_at: all[0]?.last_sync || null,
            });

        } catch (error) {
            console.error('[GroupController] getGroupsByCategory Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── POST /accounts/:accountId/groups/sync ──────────────────────────────────
    async syncGroups(req, res) {
        try {
            const { accountId } = req.params;
            const sock = WhatsAppManager.getSession(accountId);

            if (!sock) {
                const accountDB = await DatabaseManager.getAccountDB(accountId);
                await this._ensureGroupsTable(accountDB);
                const cached = await this._getCachedGroups(accountDB);
                return res.status(400).json({
                    success:        false,
                    error:          'حساب واتساب غير متصل.',
                    cached_groups:  cached,
                    cached_count:   cached.length,
                });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);
            await this._ensureSyncSettingsTable(accountDB);

            const groups = await this._syncFromWhatsApp(accountId, sock, accountDB);
            const stats  = this._buildStats(groups);

            await accountDB.run(
                `UPDATE group_sync_settings SET last_auto_sync = NOW(), updated_at = NOW()
                 WHERE account_id = $1`, [accountId]
            ).catch(() => {});

            res.json({
                success:   true,
                groups,
                count:     groups.length,
                stats,
                synced_at: new Date().toISOString(),
                message:   `✅ تم مزامنة ${groups.length} مجموعة بنجاح`,
            });

        } catch (error) {
            console.error('[GroupController] syncGroups Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:accountId/groups/sync-settings ──────────────────────────
    async getSyncSettings(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSyncSettingsTable(accountDB);

            let settings = await accountDB.get(
                `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
            );

            if (!settings) {
                await accountDB.run(
                    `INSERT INTO group_sync_settings
                     (account_id, interval_minutes, auto_sync_enabled)
                     VALUES ($1, 15, TRUE)
                     ON CONFLICT (account_id) DO NOTHING`, [accountId]
                );
                settings = await accountDB.get(
                    `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
                );
            }

            res.json({ success: true, settings });

        } catch (error) {
            console.error('[GroupController] getSyncSettings Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── PUT /accounts/:accountId/groups/sync-settings ──────────────────────────
    async updateSyncSettings(req, res) {
        try {
            const { accountId } = req.params;
            const { interval_minutes, auto_sync_enabled } = req.body;

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSyncSettingsTable(accountDB);

            await accountDB.run(
                `INSERT INTO group_sync_settings
                 (account_id, interval_minutes, auto_sync_enabled, updated_at)
                 VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (account_id) DO UPDATE SET
                     interval_minutes  = EXCLUDED.interval_minutes,
                     auto_sync_enabled = EXCLUDED.auto_sync_enabled,
                     updated_at        = NOW()`,
                [accountId,
                 parseInt(interval_minutes) || 15,
                 auto_sync_enabled !== false]
            );

            const updated = await accountDB.get(
                `SELECT * FROM group_sync_settings WHERE account_id = $1`, [accountId]
            );

            res.json({
                success:  true,
                settings: updated,
                message:  '✅ تم حفظ إعدادات المزامنة',
            });

        } catch (error) {
            console.error('[GroupController] updateSyncSettings Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:accountId/groups/:groupId/members ──────────────────────
    async getGroupMembers(req, res) {
        try {
            const { accountId, groupId } = req.params;
            const jid    = decodeURIComponent(groupId);
            const result = await WhatsAppManager.getGroupMembers(accountId, jid);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[GroupController] getGroupMembers Error:', error);
            res.status(500).json({ success: false, error: 'فشل جلب أعضاء المجموعة' });
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // المنطق الأساسي
    // ─────────────────────────────────────────────────────────────────────────

    async _getCachedGroups(accountDB) {
        const rows = await accountDB.all(
            `SELECT * FROM wa_groups WHERE is_member = TRUE ORDER BY members_count DESC`
        );
        return rows.map(r => this._formatGroup(r));
    }

    async _syncFromWhatsApp(accountId, sock, accountDB) {
        const raw   = await sock.groupFetchAllParticipating();
        const myJid = (sock.user?.id || '').replace(/:\d+@/, '@');

        const groups         = [];
        const activeGroupIds = new Set();

        for (const [jid, meta] of Object.entries(raw)) {
            if (!jid.endsWith('@g.us')) continue;
            activeGroupIds.add(jid);

            const myParticipant = meta.participants?.find(p => {
                const pBase = p.id.replace(/:\d+@/, '@');
                const mBase = myJid.replace(/:\d+@/, '@');
                return pBase === mBase || pBase.split('@')[0] === mBase.split('@')[0];
            });

            const isAdmin  = myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin';
            const isMember = !!myParticipant;
            const announce = !!meta.announce;
            const canPublish = !announce || isAdmin;

            const canSendText   = isMember && canPublish;
            const canSendImages = isMember && canPublish;
            const canSendVideo  = isMember && canPublish;
            const canSendFiles  = isMember && canPublish;
            const canSendLinks  = isMember && canPublish;
            const canBroadcast  = isMember && isAdmin;

            // تصنيف حالة النشر
            let publishStatus;
            if (!isMember)      publishStatus = 'red';
            else if (!announce) publishStatus = 'green';
            else if (isAdmin)   publishStatus = 'yellow';
            else                publishStatus = 'red';

            let avatarUrl = null;
            try {
                const avatarPromise = sock.profilePictureUrl(jid, 'image');
                const timeout = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), 3000)
                );
                avatarUrl = await Promise.race([avatarPromise, timeout]);
            } catch (_) {}

            const membersCount  = meta.participants?.length || 0;
            const adminsCount   = meta.participants?.filter(p => p.admin).length || 0;
            const activityLevel = this._estimateActivity(meta);

            await accountDB.run(`
                INSERT INTO wa_groups (
                    id, group_jid, name, description, owner, members_count, admins_count,
                    announce, restrict_mode, creation_ts, avatar_url,
                    is_member, is_admin, publish_status,
                    can_send_text, can_send_images, can_send_video,
                    can_send_files, can_send_links, can_broadcast,
                    activity_level, last_sync
                ) VALUES (
                    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                    $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
                )
                ON CONFLICT (group_jid) DO UPDATE SET
                    name            = EXCLUDED.name,
                    description     = EXCLUDED.description,
                    owner           = EXCLUDED.owner,
                    members_count   = EXCLUDED.members_count,
                    admins_count    = EXCLUDED.admins_count,
                    announce        = EXCLUDED.announce,
                    restrict_mode   = EXCLUDED.restrict_mode,
                    avatar_url      = EXCLUDED.avatar_url,
                    is_member       = EXCLUDED.is_member,
                    is_admin        = EXCLUDED.is_admin,
                    publish_status  = EXCLUDED.publish_status,
                    can_send_text   = EXCLUDED.can_send_text,
                    can_send_images = EXCLUDED.can_send_images,
                    can_send_video  = EXCLUDED.can_send_video,
                    can_send_files  = EXCLUDED.can_send_files,
                    can_send_links  = EXCLUDED.can_send_links,
                    can_broadcast   = EXCLUDED.can_broadcast,
                    activity_level  = EXCLUDED.activity_level,
                    last_sync       = EXCLUDED.last_sync
            `, [
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

        // تحديث المجموعات التي خرج منها الحساب (مؤرشفة)
        if (activeGroupIds.size > 0) {
            const ids = Array.from(activeGroupIds);
            const ph  = ids.map((_, i) => `$${i + 1}`).join(',');
            await accountDB.run(
                `UPDATE wa_groups SET is_member = FALSE WHERE group_jid NOT IN (${ph})`, ids
            ).catch(() => {});
        }

        return groups.sort((a, b) => b.members_count - a.members_count);
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

    async _ensureSyncSettingsTable(accountDB) {
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
        await accountDB.run(`
            INSERT INTO group_sync_settings (account_id)
            VALUES ($1)
            ON CONFLICT (account_id) DO NOTHING
        `, ['default']).catch(() => {});
    }

    _buildStats(groups) {
        const total          = groups.length;
        const canPublish     = groups.filter(g => g.publish_status === 'green').length;
        const restricted     = groups.filter(g => g.publish_status === 'yellow').length;
        const blocked        = groups.filter(g => g.publish_status === 'red').length;
        const asAdmin        = groups.filter(g => g.is_admin).length;
        const members        = groups.reduce((s, g) => s + (g.members_count || 0), 0);
        const avgActivity    = total
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
}

module.exports = new GroupController();
