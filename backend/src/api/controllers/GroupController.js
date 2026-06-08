'use strict';
/**
 * GroupController — مجموعات واتساب الحقيقية
 * يجلب المجموعات مباشرة من WhatsApp ويخزنها في قاعدة البيانات
 * مع فحص كامل لصلاحيات النشر لكل مجموعة
 */
const WhatsAppManager  = require('../../bot/WhatsAppManager');
const DatabaseManager  = require('../../database/DatabaseManager');
const { v4: uuidv4 }  = require('uuid');

class GroupController {

    // ── GET /accounts/:accountId/groups ────────────────────────────────────────
    // يقرأ من DB (سريع). إذا كانت الـDB فارغة أو ?refresh=1 → يجلب من واتساب.
    async getGroups(req, res) {
        try {
            const { accountId } = req.params;
            const forceRefresh  = req.query.refresh === '1';

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);

            const cached = await accountDB.all(
                `SELECT * FROM wa_groups WHERE is_member = TRUE ORDER BY members_count DESC`
            );

            // إذا طُلب تحديث فوري أو لا توجد بيانات → جلب من واتساب
            if (forceRefresh || cached.length === 0) {
                const sock = WhatsAppManager.getSession(accountId);
                if (sock) {
                    const synced = await this._syncFromWhatsApp(accountId, sock, accountDB);
                    return res.json({
                        success:    true,
                        groups:     synced,
                        count:      synced.length,
                        source:     'whatsapp',
                        synced_at:  new Date().toISOString(),
                    });
                }
                // واتساب غير متصل → إرجاع ما في قاعدة البيانات مع تحذير
                if (cached.length === 0) {
                    return res.json({
                        success: true,
                        groups:  [],
                        count:   0,
                        source:  'cache',
                        warning: 'جلسة واتساب غير متصلة. يرجى الاتصال بالحساب أولاً.',
                    });
                }
            }

            return res.json({
                success:   true,
                groups:    cached.map(r => this._formatGroup(r)),
                count:     cached.length,
                source:    'cache',
                synced_at: cached[0]?.last_sync || null,
            });

        } catch (error) {
            console.error('[GroupController] getGroups Error:', error);
            res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }

    // ── POST /accounts/:accountId/groups/sync ──────────────────────────────────
    // مزامنة كاملة وإجبارية من واتساب → قاعدة البيانات
    async syncGroups(req, res) {
        try {
            const { accountId } = req.params;
            const sock = WhatsAppManager.getSession(accountId);

            if (!sock) {
                return res.status(400).json({
                    success: false,
                    error:   'حساب واتساب غير متصل. يجب ربط الحساب أولاً قبل المزامنة.',
                });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureGroupsTable(accountDB);

            const groups    = await this._syncFromWhatsApp(accountId, sock, accountDB);
            const stats     = this._buildStats(groups);

            res.json({
                success:    true,
                groups,
                count:      groups.length,
                stats,
                synced_at:  new Date().toISOString(),
                message:    `✅ تم مزامنة ${groups.length} مجموعة بنجاح`,
            });

        } catch (error) {
            console.error('[GroupController] syncGroups Error:', error);
            res.status(500).json({
                success: false,
                error:   error.message || 'فشلت عملية المزامنة',
            });
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
    // المنطق الأساسي: جلب من واتساب وحفظ في قاعدة البيانات
    // ─────────────────────────────────────────────────────────────────────────
    async _syncFromWhatsApp(accountId, sock, accountDB) {
        // 1. جلب جميع المجموعات من واتساب دفعة واحدة
        const raw   = await sock.groupFetchAllParticipating();
        const myJid = (sock.user?.id || '').replace(/:\d+@/, '@');

        const groups         = [];
        const activeGroupIds = new Set();

        for (const [jid, meta] of Object.entries(raw)) {
            if (!jid.endsWith('@g.us')) continue;
            activeGroupIds.add(jid);

            // ── تحديد دور الحساب ──────────────────────────────────────────
            const myParticipant = meta.participants?.find(p => {
                const pBase = p.id.replace(/:\d+@/, '@');
                const mBase = myJid.replace(/:\d+@/, '@');
                return pBase === mBase || pBase.split('@')[0] === mBase.split('@')[0];
            });

            const isAdmin  = myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin';
            const isMember = !!myParticipant;

            // ── فحص صلاحيات النشر ─────────────────────────────────────────
            const announce     = !!meta.announce; // true = فقط المشرفون يرسلون
            const canPublish   = !announce || isAdmin;

            // النشر الفردي
            const canSendText   = isMember && canPublish;
            const canSendImages = isMember && canPublish;
            const canSendVideo  = isMember && canPublish;
            const canSendFiles  = isMember && canPublish;
            const canSendLinks  = isMember && canPublish;
            // البث الجماعي: يحتاج صلاحية مشرف
            const canBroadcast  = isMember && isAdmin;

            // حالة النشر الإجمالية
            let publishStatus;
            if (!isMember)     publishStatus = 'red';      // خرج من المجموعة
            else if (!announce) publishStatus = 'green';    // الجميع يرسلون
            else if (isAdmin)   publishStatus = 'yellow';   // مشرف في مجموعة إعلانات
            else                publishStatus = 'red';      // عضو عادي في مجموعة مقيدة

            // ── جلب صورة المجموعة ─────────────────────────────────────────
            let avatarUrl = null;
            try {
                avatarUrl = await sock.profilePictureUrl(jid, 'image');
            } catch (_) { /* المجموعة بدون صورة */ }

            // ── إحصائيات ──────────────────────────────────────────────────
            const membersCount = meta.participants?.length || 0;
            const adminsCount  = meta.participants?.filter(p => p.admin).length || 0;
            const activityLevel = this._estimateActivity(meta);

            // ── UPSERT في قاعدة البيانات ──────────────────────────────────
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

        // 2. تحديث المجموعات التي خرج منها الحساب (is_member = false)
        if (activeGroupIds.size > 0) {
            const ids = Array.from(activeGroupIds);
            const ph  = ids.map((_, i) => `$${i + 1}`).join(',');
            await accountDB.run(
                `UPDATE wa_groups SET is_member = FALSE WHERE group_jid NOT IN (${ph})`,
                ids
            ).catch(() => {});
        }

        return groups.sort((a, b) => b.members_count - a.members_count);
    }

    // ── تقدير مستوى النشاط من بيانات الـ metadata ────────────────────────────
    _estimateActivity(meta) {
        const memberCount = meta.participants?.length || 1;
        const adminCount  = meta.participants?.filter(p => p.admin).length || 0;
        const isAnnounce  = !!meta.announce;
        const ageInDays   = meta.creation
            ? (Date.now() / 1000 - meta.creation) / 86400
            : 365;

        let score = 50;

        // حجم المجموعة
        if (memberCount > 500) score += 30;
        else if (memberCount > 200) score += 20;
        else if (memberCount > 100) score += 12;
        else if (memberCount > 50)  score +=  6;
        else if (memberCount < 10)  score -= 15;

        // نوع المجموعة
        if (isAnnounce) score -= 20; // مجموعات الإعلانات أقل نشاطاً

        // كثرة المشرفين = إدارة جيدة = نشاط أعلى
        if (adminCount > 5) score += 8;

        // المجموعات الجديدة عادة أكثر نشاطاً
        if (ageInDays < 30)  score += 15;
        else if (ageInDays > 730) score -= 10;

        return Math.max(5, Math.min(98, score));
    }

    // ── إنشاء جدول wa_groups إذا لم يكن موجوداً ──────────────────────────────
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

    // ── بناء إحصائيات إجمالية ──────────────────────────────────────────────────
    _buildStats(groups) {
        const total      = groups.length;
        const canPublish = groups.filter(g => g.publish_status !== 'red').length;
        const restricted = groups.filter(g => g.publish_status === 'yellow').length;
        const blocked    = groups.filter(g => g.publish_status === 'red').length;
        const asAdmin    = groups.filter(g => g.is_admin).length;
        const members    = groups.reduce((s, g) => s + (g.members_count || 0), 0);
        const avgActivity = total
            ? Math.round(groups.reduce((s, g) => s + (g.activity_level || 0), 0) / total)
            : 0;

        return { total, canPublish, restricted, blocked, asAdmin, members, avgActivity };
    }

    // ── تحويل صف DB إلى نموذج API ─────────────────────────────────────────────
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
