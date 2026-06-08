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

    // ════════════════════════════════════════════════════════════════════════
    // الجزء الخامس — نشر لأعضاء المجموعات
    // ════════════════════════════════════════════════════════════════════════

    // ── جلب أعضاء مجموعات متعددة مع فلترة المشرفين والاستثناءات ──────────
    async getMembersForPublish(req, res) {
        try {
            const { accountId } = req.params;
            const { group_jids, exclude_admins, excluded_numbers } = req.body;

            if (!group_jids || group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const WhatsAppManager = require('../../bot/WhatsAppManager');
            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const excludedSet = new Set((excluded_numbers || []).map(n =>
                n.toString().replace(/[^0-9]/g, '') + '@s.whatsapp.net'
            ));

            const allTargets = [];
            const seenJids   = new Set();

            for (const groupJid of group_jids) {
                try {
                    const meta = await sock.groupMetadata(groupJid);
                    if (!meta?.participants) continue;

                    for (const p of meta.participants) {
                        const pJid = p.id.replace(/:\d+@/, '@');
                        if (seenJids.has(pJid)) continue;
                        if (exclude_admins && (p.admin === 'admin' || p.admin === 'superadmin')) continue;
                        if (excludedSet.has(pJid)) continue;
                        // لا ترسل لنفسك
                        const myJid = (sock.user?.id || '').replace(/:\d+@/, '@');
                        if (pJid === myJid) continue;

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

    // ── تنفيذ النشر الفعلي لأعضاء المجموعات ──────────────────────────────
    async publishToMembers(req, res) {
        try {
            const { accountId } = req.params;
            const {
                group_jids,
                account_ids,
                ad_library_id,
                custom_content,
                send_time,
                interval_seconds,
                exclude_admins,
                excluded_numbers,
            } = req.body;

            if (!group_jids || group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const WhatsAppManager = require('../../bot/WhatsAppManager');
            const DatabaseManager = require('../../database/DatabaseManager');
            const crypto = require('crypto');
            const path   = require('path');
            const fs     = require('fs');

            // تحديد الحسابات المستخدمة
            const useAccountIds = (account_ids && account_ids.length > 0)
                ? account_ids : [accountId];

            // جلب المحتوى
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            let messageContent = custom_content || '';
            let mediaPaths = [];

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

            // جلب كل الأعضاء المستهدفين
            const excludedSet = new Set((excluded_numbers || []).map(n =>
                n.toString().replace(/[^0-9]/g, '') + '@s.whatsapp.net'
            ));

            const allTargets = [];
            const seenJids   = new Set();

            for (const accId of useAccountIds) {
                const sock = WhatsAppManager.getSession(accId);
                if (!sock) continue;
                const myJid = (sock.user?.id || '').replace(/:\d+@/, '@');

                for (const groupJid of group_jids) {
                    try {
                        const meta = await sock.groupMetadata(groupJid);
                        if (!meta?.participants) continue;

                        for (const p of meta.participants) {
                            const pJid = p.id.replace(/:\d+@/, '@');
                            if (seenJids.has(pJid)) continue;
                            if (pJid === myJid) continue;
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

            // إذا كان هناك وقت مجدول — أنشئ مهمة مجدولة
            if (send_time && new Date(send_time) > new Date()) {
                const jobId = crypto.randomUUID();
                const sysDB = await DatabaseManager.getSystemDB();
                await sysDB.run(`
                    CREATE TABLE IF NOT EXISTS member_publish_jobs (
                        id TEXT PRIMARY KEY,
                        account_id TEXT,
                        targets TEXT,
                        message_content TEXT,
                        media_paths TEXT,
                        ad_library_id TEXT,
                        interval_seconds INTEGER DEFAULT 3,
                        status TEXT DEFAULT 'pending',
                        scheduled_at TIMESTAMP,
                        started_at TIMESTAMP,
                        completed_at TIMESTAMP,
                        total_count INTEGER DEFAULT 0,
                        sent_count INTEGER DEFAULT 0,
                        failed_count INTEGER DEFAULT 0,
                        created_at TIMESTAMP DEFAULT NOW()
                    )
                `).catch(() => {});

                await sysDB.run(`
                    INSERT INTO member_publish_jobs
                    (id, account_id, targets, message_content, media_paths, ad_library_id, interval_seconds, scheduled_at, total_count)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                `, [
                    jobId, accountId,
                    JSON.stringify(allTargets.map(t => ({ jid: t.jid, accountId: t.accountId }))),
                    messageContent,
                    JSON.stringify(mediaPaths),
                    ad_library_id || null,
                    interval_seconds || 3,
                    send_time,
                    allTargets.length,
                ]);

                return res.json({
                    success: true,
                    scheduled: true,
                    job_id: jobId,
                    count: allTargets.length,
                    message: `✅ تم جدولة الإرسال لـ ${allTargets.length} عضو في ${new Date(send_time).toLocaleString('ar-SA')}`,
                });
            }

            // إرسال فوري
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
                                    fileName: path.basename(mediaPaths[0])
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

            // تسجيل في DB
            const logId = crypto.randomUUID();
            await accountDB.run(`
                CREATE TABLE IF NOT EXISTS member_publish_log (
                    id TEXT PRIMARY KEY,
                    account_id TEXT,
                    ad_library_id TEXT,
                    group_jids TEXT,
                    excluded_numbers TEXT,
                    exclude_admins BOOLEAN DEFAULT FALSE,
                    total_targets INTEGER DEFAULT 0,
                    sent_count INTEGER DEFAULT 0,
                    failed_count INTEGER DEFAULT 0,
                    message_content TEXT,
                    status TEXT DEFAULT 'completed',
                    created_at TIMESTAMP DEFAULT NOW()
                )
            `).catch(() => {});

            await accountDB.run(`
                INSERT INTO member_publish_log
                (id, account_id, ad_library_id, group_jids, excluded_numbers, exclude_admins, total_targets, sent_count, failed_count, message_content, status)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            `, [
                logId, accountId, ad_library_id || null,
                JSON.stringify(group_jids),
                JSON.stringify(excluded_numbers || []),
                !!exclude_admins,
                allTargets.length, sent, failed,
                messageContent,
                failed === 0 ? 'completed' : 'partial',
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

    // ── إدارة قائمة الاستثناءات ───────────────────────────────────────────
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
            console.error('[GroupController] getExclusions Error:', err);
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
            console.error('[GroupController] addExclusions Error:', err);
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

    // ── تصدير أعضاء مجموعة ────────────────────────────────────────────────
    async exportMembers(req, res) {
        try {
            const { accountId, groupId } = req.params;
            const format = req.query.format || 'csv'; // csv | txt | json
            const jid    = decodeURIComponent(groupId);

            const WhatsAppManager = require('../../bot/WhatsAppManager');
            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const meta = await sock.groupMetadata(jid);
            if (!meta) return res.status(404).json({ success: false, error: 'المجموعة غير موجودة' });

            const groupName = meta.subject || 'group';
            const extractedAt = new Date().toISOString();
            const members = (meta.participants || []).map(p => ({
                phone:      p.id.replace(/:\d+@.*/, '').replace(/@.*/, ''),
                jid:        p.id,
                role:       p.admin === 'superadmin' ? 'مشرف رئيسي' : p.admin === 'admin' ? 'مشرف' : 'عضو',
                group_name: groupName,
                extracted_at: extractedAt,
            }));

            // حفظ في قاعدة البيانات
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSavedMembersTable(accountDB);
            const crypto = require('crypto');
            for (const m of members) {
                await accountDB.run(`
                    INSERT INTO saved_group_members (id, account_id, phone, group_jid, group_name, role, extracted_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)
                    ON CONFLICT (account_id, phone, group_jid) DO UPDATE SET
                        role = EXCLUDED.role, extracted_at = EXCLUDED.extracted_at
                `, [crypto.randomUUID(), accountId, m.phone, jid, groupName, m.role, extractedAt]).catch(() => {});
            }

            if (format === 'json') {
                return res.json({ success: true, members, count: members.length, group_name: groupName });
            }

            if (format === 'csv') {
                const header = 'الرقم,الدور,اسم المجموعة,تاريخ الاستخراج\n';
                const rows   = members.map(m =>
                    `${m.phone},${m.role},"${m.group_name}",${m.extracted_at}`
                ).join('\n');
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="members_${groupName}_${Date.now()}.csv"`);
                return res.send('\ufeff' + header + rows); // BOM for Excel Arabic
            }

            if (format === 'txt') {
                const lines = members.map(m => `+${m.phone}`).join('\n');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="members_${groupName}_${Date.now()}.txt"`);
                return res.send(lines);
            }

            // xlsx — إرجاع JSON ليعالجه الفرونت
            res.json({ success: true, members, count: members.length, group_name: groupName });

        } catch (err) {
            console.error('[GroupController] exportMembers Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    // ── تصدير أعضاء مجموعات متعددة ───────────────────────────────────────
    async exportMultipleGroupsMembers(req, res) {
        try {
            const { accountId } = req.params;
            const { group_jids, format } = req.body;
            const fmt = format || 'csv';

            if (!group_jids || group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const WhatsAppManager = require('../../bot/WhatsAppManager');
            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const allMembers = [];
            const seenPhones = new Set();
            const extractedAt = new Date().toISOString();

            for (const jid of group_jids) {
                try {
                    const meta = await sock.groupMetadata(jid);
                    if (!meta?.participants) continue;
                    const groupName = meta.subject || jid;

                    for (const p of meta.participants) {
                        const phone = p.id.replace(/:\d+@.*/, '').replace(/@.*/, '');
                        if (seenPhones.has(phone)) continue;
                        seenPhones.add(phone);
                        allMembers.push({
                            phone,
                            role:       p.admin === 'superadmin' ? 'مشرف رئيسي' : p.admin === 'admin' ? 'مشرف' : 'عضو',
                            group_name: groupName,
                            extracted_at: extractedAt,
                        });
                    }
                } catch (e) {
                    console.warn(`[exportMultiple] skip ${jid}:`, e.message);
                }
            }

            // حفظ في قاعدة البيانات
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSavedMembersTable(accountDB);
            const crypto = require('crypto');
            for (const m of allMembers) {
                const jidForSave = group_jids[0]; // نستخدم الأولى كمرجع
                await accountDB.run(`
                    INSERT INTO saved_group_members (id, account_id, phone, group_jid, group_name, role, extracted_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7)
                    ON CONFLICT (account_id, phone, group_jid) DO UPDATE SET
                        role = EXCLUDED.role, extracted_at = EXCLUDED.extracted_at
                `, [crypto.randomUUID(), accountId, m.phone, jidForSave, m.group_name, m.role, extractedAt]).catch(() => {});
            }

            if (fmt === 'csv') {
                const header = 'الرقم,الدور,اسم المجموعة,تاريخ الاستخراج\n';
                const rows   = allMembers.map(m =>
                    `${m.phone},${m.role},"${m.group_name}",${m.extracted_at}`
                ).join('\n');
                res.setHeader('Content-Type', 'text/csv; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="all_members_${Date.now()}.csv"`);
                return res.send('\ufeff' + header + rows);
            }

            if (fmt === 'txt') {
                const lines = allMembers.map(m => `+${m.phone}`).join('\n');
                res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                res.setHeader('Content-Disposition', `attachment; filename="all_members_${Date.now()}.txt"`);
                return res.send(lines);
            }

            res.json({ success: true, members: allMembers, count: allMembers.length });

        } catch (err) {
            console.error('[GroupController] exportMultipleGroupsMembers Error:', err);
            res.status(500).json({ success: false, error: err.message });
        }
    }

    // ── جلب الأعضاء المحفوظين في قاعدة البيانات ─────────────────────────
    async getSavedMembers(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureSavedMembersTable(accountDB);
            const rows = await accountDB.all(
                `SELECT * FROM saved_group_members WHERE account_id = $1 ORDER BY extracted_at DESC LIMIT 5000`,
                [accountId]
            );
            res.json({ success: true, members: rows, count: rows.length });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    }

    // ── Helpers للجداول الجديدة ────────────────────────────────────────────
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

    async _ensureSavedMembersTable(accountDB) {
        await accountDB.run(`
            CREATE TABLE IF NOT EXISTS saved_group_members (
                id           TEXT PRIMARY KEY,
                account_id   TEXT NOT NULL,
                phone        TEXT NOT NULL,
                group_jid    TEXT NOT NULL,
                group_name   TEXT DEFAULT '',
                role         TEXT DEFAULT 'عضو',
                extracted_at TIMESTAMP DEFAULT NOW(),
                UNIQUE(account_id, phone, group_jid)
            )
        `);
    }
}

module.exports = new GroupController();

