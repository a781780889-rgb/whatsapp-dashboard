const DatabaseManager = require('../../database/DatabaseManager');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const LivePublishService = require('../services/LivePublishService');
const { queryAll: pgQueryAll } = require('../../lib/postgres');
const { ProtectionService } = require('../services/ProtectionService');

class BroadcastController {

    // ── [البند 1+2] جلب userId الخاص بحساب معيّن (لاستخدام safeDelay المرتبط
    //    بإعدادات المستخدم بدل أي تأخير ثابت). كاش بسيط بالذاكرة لمدة قصيرة
    //    لتفادي استعلام DB متكرر داخل حلقات الإرسال الكثيفة. ──────────────────
    async _getUserId(accountId) {
        this._userIdCache = this._userIdCache || new Map();
        const cached = this._userIdCache.get(accountId);
        if (cached && (Date.now() - cached.ts) < 60000) return cached.userId;
        try {
            const row = await pgQueryAll(`SELECT user_id FROM accounts WHERE id = $1`, [accountId]);
            const userId = row?.[0]?.user_id || null;
            this._userIdCache.set(accountId, { userId, ts: Date.now() });
            return userId;
        } catch {
            return null;
        }
    }

    // ── [البند 1+2] تأخير آمن وعشوائي بدل أي setTimeout ثابت. يتدهور بأمان
    //    (fallback لقيمة عشوائية بسيطة) إن تعذّر تحديد userId. ─────────────────
    async _safeDelay(accountId, operationType = 'group') {
        const userId = await this._getUserId(accountId);
        if (!userId) {
            const ms = 800 + Math.floor(Math.random() * 700);
            return new Promise(r => setTimeout(r, ms));
        }
        const svc = ProtectionService.getInstance();
        return svc.safeDelay(userId, operationType);
    }

    async getAll(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const broadcasts = await accountDB.all(
                `SELECT b.id, b.name, b.status, b.created_at, b.updated_at,
                 COALESCE(b.target_group_jids, '[]') as target_group_jids,
                 COALESCE(b.ad_library_ids, '[]') as ad_library_ids,
                 COALESCE(b.active_days, '[0,1,2,3,4,5,6]') as active_days,
                 COALESCE(b.publish_times, '[]') as publish_times,
                 COALESCE(b.max_per_day, 3) as max_per_day,
                 COALESCE(b.rotation_mode, 'sequential') as rotation_mode,
                 COALESCE(b.send_to_members, false) as send_to_members,
                 COALESCE(b.exclude_admins, true) as exclude_admins
                 FROM broadcast_schedules b
                 WHERE (b.account_id = $1 OR b.account_id IS NULL)
                 ORDER BY b.created_at DESC`,
                [accountId]
            );
            const parsed = broadcasts.map(b => ({
                ...b,
                target_group_jids: this._safeJSON(b.target_group_jids, []),
                ad_library_ids: this._safeJSON(b.ad_library_ids, []),
                active_days: this._safeJSON(b.active_days, [0,1,2,3,4,5,6]),
                publish_times: this._safeJSON(b.publish_times, []),
            }));
            res.json({ success: true, schedules: parsed, broadcasts: parsed });
        } catch (err) {
            console.error('Broadcast getAll error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async create(req, res) {
        try {
            const { accountId } = req.params;
            const {
                name, target_group_jids, ad_library_ids,
                rotation_mode, active_days, publish_times, max_per_day,
                send_to_members = false, exclude_admins = true
            } = req.body;

            if (!name) return res.status(400).json({ success: false, error: 'اسم الجدولة مطلوب' });
            if (!ad_library_ids || ad_library_ids.length === 0) return res.status(400).json({ success: false, error: 'يجب اختيار إعلان واحد على الأقل' });
            if (!target_group_jids || target_group_jids.length === 0) return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const id = crypto.randomUUID();

            await accountDB.run(
                `INSERT INTO broadcast_schedules 
                 (id, name, account_id, target_group_jids, ad_library_ids, rotation_mode, active_days, publish_times, max_per_day, status, send_to_members, exclude_admins)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'paused', $10, $11)`,
                [id, name, accountId,
                    JSON.stringify(target_group_jids || []),
                    JSON.stringify(ad_library_ids || []),
                    rotation_mode || 'sequential',
                    JSON.stringify(active_days || [0,1,2,3,4,5,6]),
                    JSON.stringify(publish_times || []),
                    max_per_day || 3,
                    send_to_members ? true : false,
                    exclude_admins ? true : false]
            );

            res.status(201).json({ success: true, broadcastId: id, message: 'تم إنشاء الجدولة بنجاح' });
        } catch (err) {
            console.error('Broadcast create error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async start(req, res) {
        try {
            const { accountId, id } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `UPDATE broadcast_schedules SET status = 'active', updated_at = NOW() WHERE id = $1`,
                [id]
            );
            res.json({ success: true, message: 'تم تشغيل الجدولة' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async pause(req, res) {
        try {
            const { accountId, id } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `UPDATE broadcast_schedules SET status = 'paused', updated_at = NOW() WHERE id = $1`,
                [id]
            );
            res.json({ success: true, message: 'تم إيقاف الجدولة مؤقتاً' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async delete(req, res) {
        try {
            const { accountId, id } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(`DELETE FROM broadcast_schedules WHERE id = $1`, [id]);
            res.json({ success: true, message: 'تم حذف الجدولة' });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── Helper: build message content from ad ─────────────────────────────────
    _buildMessageContent(ad) {
        let mediaPaths = ad.media_paths;
        if (typeof mediaPaths === 'string') {
            try { mediaPaths = JSON.parse(mediaPaths || '[]'); } catch { mediaPaths = []; }
        } else if (!Array.isArray(mediaPaths)) {
            mediaPaths = [];
        }
        return {
            text: ad.content || '',
            mediaPaths,
        };
    }

    // ── Helper: send one message to a JID — [البند 1] يمر إلزامياً عبر
    //    WhatsAppManager.sendMessageSafe، وهي النقطة المركزية الوحيدة المسموح
    //    بها للإرسال: تستدعي ProtectionService.checkOperation قبل الإرسال،
    //    تحاكي السلوك البشري (composing/typing/paused)، ثم تسجل النتيجة عبر
    //    recordSuccess/recordFailure تلقائياً. لا إرسال مباشر بعد الآن. ───────
    async _sendOne(accountId, jid, messageContent, options = {}) {
        const MEDIA_BASE = path.resolve(__dirname, '../../../../');
        const { text, mediaPaths } = messageContent;
        let content;
        if (mediaPaths && mediaPaths.length > 0) {
            const mediaPath = path.join(MEDIA_BASE, mediaPaths[0]);
            if (fs.existsSync(mediaPath)) {
                const mediaBuffer = fs.readFileSync(mediaPath);
                const ext = path.extname(mediaPaths[0]).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                    content = { image: mediaBuffer, caption: text };
                } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
                    content = { video: mediaBuffer, caption: text };
                } else {
                    content = { document: mediaBuffer, caption: text, fileName: path.basename(mediaPaths[0]) };
                }
            }
        }
        if (!content) content = { text: text || '' };

        return WhatsAppManager.sendMessageSafe(accountId, jid, content, options);
    }

    // ── Direct Publish — instant send ─────────────────────────────────────────
    // [FIX-DIRECT-PUBLISH-3] دعم تعدد الإعلانات (ad_library_ids) بالترتيب مع
    // احترام التأخير الزمني المحدد، إضافة لاستمرار دعم ad_library_id المفرد
    // للتوافق مع أي طلبات قديمة. + إصلاح الإرسال للأعضاء الخاص الذي كان يفشل
    // بصمت بسبب الشكل غير المتوافق لـ getGroupMembers. + سجل إرسال تفصيلي.
    async directPublish(req, res) {
        try {
            const { accountId } = req.params;
            const {
                target_group_jids,
                ad_library_id,
                ad_library_ids,
                custom_content,
                send_to_members = false,
                exclude_admins = true,
                member_delay_ms,      // تأخير بين كل رسالة خاصة لعضو (ms) — افتراضي 1500
                ad_delay_ms,          // تأخير بين كل إعلان عند تعدد الإعلانات (ms) — افتراضي 2000
            } = req.body;

            if (!target_group_jids || target_group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const session = WhatsAppManager.getSession(accountId);
            if (!session) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }
            // [البند 3] لا نرسل من حساب موقوف تلقائياً (محظور/متجاوز الأخطاء)
            const userIdForCheck = await this._getUserId(accountId);
            if (userIdForCheck && await ProtectionService.getInstance().isSuspended(userIdForCheck, accountId)) {
                return res.status(403).json({ success: false, error: 'الحساب موقوف تلقائياً بسبب الحماية (حظر أو أخطاء متكررة) — لا يمكن الإرسال منه' });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureDirectPublishLogTable(accountDB);

            // بناء قائمة الإعلانات المطلوب إرسالها بالترتيب
            const orderedAdIds = (Array.isArray(ad_library_ids) && ad_library_ids.length > 0)
                ? ad_library_ids
                : (ad_library_id ? [ad_library_id] : []);

            const messages = []; // [{ adId, name, text, mediaPaths }]
            for (const adId of orderedAdIds) {
                const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [adId]);
                if (ad) {
                    messages.push({ adId, name: ad.name, ...this._buildMessageContent(ad) });
                    await accountDB.run(
                        `UPDATE ad_library SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1`,
                        [adId]
                    ).catch(() => {});
                }
            }
            if (messages.length === 0) {
                messages.push({ adId: null, name: null, text: custom_content || '', mediaPaths: [] });
            }

            if (messages.every(m => !m.text && (!m.mediaPaths || m.mediaPaths.length === 0))) {
                return res.status(400).json({ success: false, error: 'يجب إضافة نص أو وسائط للرسالة' });
            }

            // [البند 1+2] memberDelay/adDelay لم تعد تُستخدم فعلياً للتأخير (استُبدلت
            // بـ ProtectionService.safeDelay العشوائي)، ونُبقيها فقط لأغراض التوافق مع
            // الواجهة الأمامية وسجل الإرسال (قيمة توثيقية لا تؤثر على التوقيت الفعلي).
            const memberDelay = Number.isFinite(member_delay_ms) ? Math.max(0, member_delay_ms) : 1500;
            const adDelay     = Number.isFinite(ad_delay_ms)     ? Math.max(0, ad_delay_ms)     : 2000;

            const results       = [];
            const groupDetails  = []; // تفاصيل لكل مجموعة لسجل الإرسال
            let membersSentTotal   = 0;
            let membersFailedTotal = 0;
            let membersTargetedTotal = 0;
            let groupsSent   = 0;
            let groupsFailed = 0;
            let accountSuspendedMidRun = false; // [البند 3] توقف فوري إذا تعلّق الحساب أثناء التنفيذ

            for (const jid of target_group_jids) {
                if (accountSuspendedMidRun) {
                    results.push({ jid, type: 'group', status: 'skipped', error: 'تم إيقاف الحساب أثناء التنفيذ' });
                    groupsFailed++;
                    continue;
                }

                const detail = {
                    group_jid: jid,
                    group_sent: 0,
                    group_failed: 0,
                    members_targeted: 0,
                    members_sent: 0,
                    members_failed: 0,
                    errors: [],
                };

                // 1️⃣ إرسال للمجموعة (كل الإعلانات بالترتيب) — عبر sendMessageSafe المحمي
                for (let i = 0; i < messages.length; i++) {
                    const msg = messages[i];
                    try {
                        await this._sendOne(accountId, jid, msg, { operationType: 'group' });
                        results.push({ jid, type: 'group', status: 'sent', ad_id: msg.adId });
                        detail.group_sent++;
                    } catch (sendErr) {
                        results.push({ jid, type: 'group', status: 'failed', ad_id: msg.adId, error: sendErr.message });
                        detail.group_failed++;
                        detail.errors.push(`فشل إرسال الإعلان للمجموعة: ${sendErr.message}`);
                        // [البند 3] إن كان السبب تعليق الحساب (محظور/متجاوز حد)، نوقف كل العمليات الباقية فوراً
                        if (sendErr.protectionReason === 'account_suspended') {
                            accountSuspendedMidRun = true;
                            break;
                        }
                    }
                    if (accountSuspendedMidRun) break;
                    // [البند 1+2] تأخير عشوائي آمن بدل setTimeout الثابت
                    await this._safeDelay(accountId, 'group');
                }
                if (detail.group_sent > 0) groupsSent++;
                else groupsFailed++;

                // 2️⃣ إرسال للأعضاء خاص (باستثناء المشرفين إذا كان الخيار مفعلاً)
                if (send_to_members && !accountSuspendedMidRun) {
                    try {
                        // [FIX-DIRECT-PUBLISH-2] التحقق من صلاحية قراءة أعضاء المجموعة قبل الإرسال
                        const membersInfo = await WhatsAppManager.getGroupMembers(accountId, jid);
                        const targets = exclude_admins
                            ? membersInfo.target_jids            // أعضاء فقط (بدون مشرفين)
                            : [...membersInfo.target_jids, ...membersInfo.admins];

                        detail.members_targeted = targets.length;
                        membersTargetedTotal += targets.length;

                        for (const memberJid of targets) {
                            if (accountSuspendedMidRun) break;
                            for (let i = 0; i < messages.length; i++) {
                                const msg = messages[i];
                                try {
                                    await this._sendOne(accountId, memberJid, msg, { operationType: 'private' });
                                    membersSentTotal++;
                                    detail.members_sent++;
                                    results.push({ jid: memberJid, type: 'private', status: 'sent', fromGroup: jid, ad_id: msg.adId });
                                } catch (e) {
                                    membersFailedTotal++;
                                    detail.members_failed++;
                                    results.push({ jid: memberJid, type: 'private', status: 'failed', fromGroup: jid, ad_id: msg.adId, error: e.message });
                                    // [البند 3] توقف فوري عند تعليق الحساب أثناء الإرسال للأعضاء أيضاً
                                    if (e.protectionReason === 'account_suspended') {
                                        accountSuspendedMidRun = true;
                                        break;
                                    }
                                }
                                if (accountSuspendedMidRun) break;
                                if (i < messages.length - 1) await this._safeDelay(accountId, 'private');
                            }
                            if (!accountSuspendedMidRun) {
                                // [البند 1+2] تأخير عشوائي آمن بين الرسائل الخاصة لتجنب الحظر
                                await this._safeDelay(accountId, 'private');
                            }
                        }
                    } catch (membersErr) {
                        // [مطلوب] في حال تعذّر جلب أعضاء مجموعة معينة، نسجل الخطأ ونستمر بباقي المجموعات
                        console.error(`[Broadcast] Failed to get members for ${jid}:`, membersErr.message);
                        results.push({ jid, type: 'members_fetch', status: 'failed', error: membersErr.message });
                        detail.errors.push(`تعذّر قراءة أعضاء المجموعة: ${membersErr.message}`);
                    }
                }

                groupDetails.push(detail);
            }

            // تسجيل في قاعدة البيانات
            const logId = crypto.randomUUID();
            const groupSentCount = results.filter(r => r.type === 'group' && r.status === 'sent').length;
            const overallStatus = groupsFailed === 0 && membersFailedTotal === 0 ? 'sent' : 'partial';

            await accountDB.run(
                `INSERT INTO direct_publish_log
                 (id, account_id, ad_library_id, ad_library_ids, target_group_jids, custom_content, status,
                  send_to_members, exclude_admins, members_sent, groups_targeted, groups_sent, groups_failed,
                  members_targeted, members_failed, member_delay_ms, details)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
                [
                    logId, accountId, orderedAdIds[0] || null, JSON.stringify(orderedAdIds),
                    JSON.stringify(target_group_jids), custom_content || '',
                    overallStatus,
                    send_to_members ? true : false,
                    exclude_admins ? true : false,
                    membersSentTotal,
                    target_group_jids.length,
                    groupsSent,
                    groupsFailed,
                    membersTargetedTotal,
                    membersFailedTotal,
                    memberDelay,
                    JSON.stringify(groupDetails),
                ]
            );

            res.json({
                success: true,
                message: send_to_members
                    ? `تم الإرسال لـ ${groupSentCount} مجموعة + ${membersSentTotal} عضو (خاص)${membersFailedTotal ? ` — فشل ${membersFailedTotal}` : ''}`
                    : `تم الإرسال لـ ${groupSentCount} من ${target_group_jids.length} مجموعة`,
                results,
                summary: {
                    groups_targeted: target_group_jids.length,
                    groups_sent: groupsSent,
                    groups_failed: groupsFailed,
                    members_targeted: membersTargetedTotal,
                    members_sent: membersSentTotal,
                    members_failed: membersFailedTotal,
                    ads_sent: orderedAdIds.length,
                },
                details: groupDetails,
            });
        } catch (err) {
            console.error('DirectPublish error:', err);
            res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
        }
    }

    // ── ضمان وجود الأعمدة الجديدة لسجل الإرسال التفصيلي (للحسابات القديمة) ──
    async _ensureDirectPublishLogTable(accountDB) {
        try {
            await accountDB.run(`
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS ad_library_ids JSONB DEFAULT '[]';
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS groups_targeted INT DEFAULT 0;
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS groups_sent INT DEFAULT 0;
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS groups_failed INT DEFAULT 0;
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS members_targeted INT DEFAULT 0;
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS members_failed INT DEFAULT 0;
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS member_delay_ms INT DEFAULT 1500;
                ALTER TABLE direct_publish_log ADD COLUMN IF NOT EXISTS details JSONB DEFAULT '[]';
            `);
        } catch (e) {
            console.warn('[Broadcast] _ensureDirectPublishLogTable warning:', e.message);
        }
    }

    async getDirectPublishLog(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await this._ensureDirectPublishLogTable(accountDB);

            const logs = await accountDB.all(
                `SELECT l.*, a.name as ad_name FROM direct_publish_log l 
                 LEFT JOIN ad_library a ON l.ad_library_id = a.id
                 WHERE l.account_id = $1 ORDER BY l.sent_at DESC LIMIT 100`,
                [accountId]
            );

            // جلب أسماء كل الإعلانات المستخدمة في حال تعدد الإعلانات
            const allAdIds = new Set();
            for (const l of logs) {
                const ids = this._safeJSON(l.ad_library_ids, []);
                ids.forEach(id => id && allAdIds.add(id));
            }
            let adNamesMap = {};
            if (allAdIds.size > 0) {
                const idsArr = Array.from(allAdIds);
                const ph = idsArr.map((_, i) => `$${i + 1}`).join(',');
                const adRows = await accountDB.all(`SELECT id, name FROM ad_library WHERE id IN (${ph})`, idsArr).catch(() => []);
                adNamesMap = Object.fromEntries(adRows.map(r => [r.id, r.name]));
            }

            const parsed = logs.map(l => {
                const adIds = this._safeJSON(l.ad_library_ids, []);
                return {
                    ...l,
                    target_group_jids: this._safeJSON(l.target_group_jids, []),
                    ad_library_ids: adIds,
                    ad_names: adIds.map(id => adNamesMap[id] || l.ad_name).filter(Boolean),
                    details: this._safeJSON(l.details, []),
                    groups_targeted: l.groups_targeted || (this._safeJSON(l.target_group_jids, []).length || 0),
                    groups_sent: l.groups_sent || 0,
                    groups_failed: l.groups_failed || 0,
                    members_targeted: l.members_targeted || 0,
                    members_failed: l.members_failed || 0,
                };
            });
            res.json({ success: true, logs: parsed });
        } catch (err) {
            console.error('getDirectPublishLog error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── Helper: safely read a value that may already be parsed by pg (JSONB) ──
    _safeJSON(val, fallback) {
        if (val === null || val === undefined) return fallback;
        if (typeof val === 'object') return val;
        try { return JSON.parse(val); } catch { return fallback; }
    }

    // ════════════════════════════════════════════════════════════
    //  Live Publish — نشر مباشر مع Socket.IO لحظي
    // ════════════════════════════════════════════════════════════

    async startLivePublish(req, res) {
        try {
            const {
                account_ids,
                target_group_jids,
                send_to_members   = false,
                exclude_admins    = true,
                ad_library_ids    = [],
                custom_content    = '',
                member_delay_ms   = 1500,
                group_delay_ms    = 1000,
                ad_delay_ms       = 2000,
            } = req.body;

            if (!account_ids?.length)
                return res.status(400).json({ success: false, error: 'يجب اختيار حساب واحد على الأقل' });
            if (!target_group_jids?.length)
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });

            // جلب الإعلانات من قاعدة بيانات الحساب الأول
            const firstAccountId = account_ids[0];
            const accountDB = await DatabaseManager.getAccountDB(firstAccountId);

            const messages = [];
            for (const adId of (ad_library_ids || [])) {
                const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [adId]);
                if (ad) {
                    messages.push({ adId, name: ad.name, ...this._buildMessageContent(ad) });
                    await accountDB.run(
                        `UPDATE ad_library SET use_count = use_count + 1, last_used_at = NOW() WHERE id = $1`, [adId]
                    ).catch(() => {});
                }
            }
            if (!messages.length) {
                if (!custom_content?.trim())
                    return res.status(400).json({ success: false, error: 'يجب إضافة نص أو اختيار إعلان' });
                messages.push({ adId: null, name: 'رسالة مخصصة', text: custom_content, mediaPaths: [] });
            }

            // جلب أسماء الحسابات
            let accountsInfo = [];
            try {
                const ph = account_ids.map((_, i) => `$${i + 1}`).join(',');
                accountsInfo = await pgQueryAll(
                    `SELECT id, name FROM accounts WHERE id IN (${ph})`, account_ids
                );
            } catch { /* fallback */ }

            const sessionId = await LivePublishService.create({
                accountIds:    account_ids,
                accountsInfo,
                groupJids:     target_group_jids,
                sendToMembers: send_to_members,
                excludeAdmins: exclude_admins,
                messages,
                delays: {
                    memberDelayMs: Math.max(0, Number(member_delay_ms) || 1500),
                    groupDelayMs:  Math.max(0, Number(group_delay_ms)  || 1000),
                    adDelayMs:     Math.max(0, Number(ad_delay_ms)     || 2000),
                },
            });

            res.json({ success: true, sessionId });
        } catch (err) {
            console.error('[LivePublish] startLivePublish error:', err);
            res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
        }
    }

    async controlLivePublish(req, res) {
        const { sessionId } = req.params;
        const { action } = req.body;  // pause | resume | stop

        let ok = false;
        if (action === 'pause')  ok = LivePublishService.pause(sessionId);
        if (action === 'resume') ok = LivePublishService.resume(sessionId);
        if (action === 'stop')   ok = LivePublishService.stop(sessionId);

        if (!ok) return res.status(404).json({ success: false, error: 'الجلسة غير موجودة أو انتهت' });
        res.json({ success: true, action });
    }

    async getLivePublishStatus(req, res) {
        const { sessionId } = req.params;
        const s = LivePublishService.status(sessionId);
        if (!s) return res.status(404).json({ success: false, error: 'الجلسة غير موجودة' });
        res.json({ success: true, ...s });
    }
}

module.exports = new BroadcastController();
