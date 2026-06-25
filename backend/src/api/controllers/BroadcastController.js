const DatabaseManager = require('../../database/DatabaseManager');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class BroadcastController {

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
                target_group_jids: typeof b.target_group_jids === 'string' ? JSON.parse(b.target_group_jids || '[]') : (b.target_group_jids || []),
                ad_library_ids: typeof b.ad_library_ids === 'string' ? JSON.parse(b.ad_library_ids || '[]') : (b.ad_library_ids || []),
                active_days: typeof b.active_days === 'string' ? JSON.parse(b.active_days || '[0,1,2,3,4,5,6]') : (b.active_days || [0,1,2,3,4,5,6]),
                publish_times: typeof b.publish_times === 'string' ? JSON.parse(b.publish_times || '[]') : (b.publish_times || []),
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
        return {
            text: ad.content || '',
            mediaPaths: JSON.parse(ad.media_paths || '[]'),
        };
    }

    // ── Helper: send one message to a JID ─────────────────────────────────────
    async _sendOne(session, jid, messageContent) {
        const MEDIA_BASE = path.resolve(__dirname, '../../../../');
        const { text, mediaPaths } = messageContent;
        if (mediaPaths && mediaPaths.length > 0) {
            const mediaPath = path.join(MEDIA_BASE, mediaPaths[0]);
            if (fs.existsSync(mediaPath)) {
                const mediaBuffer = fs.readFileSync(mediaPath);
                const ext = path.extname(mediaPaths[0]).toLowerCase();
                if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) {
                    await session.sendMessage(jid, { image: mediaBuffer, caption: text });
                } else if (['.mp4','.mov','.avi'].includes(ext)) {
                    await session.sendMessage(jid, { video: mediaBuffer, caption: text });
                } else {
                    await session.sendMessage(jid, { document: mediaBuffer, caption: text, fileName: path.basename(mediaPaths[0]) });
                }
                return;
            }
        }
        await session.sendMessage(jid, { text: text || '' });
    }

    // ── Direct Publish — instant send ─────────────────────────────────────────
    async directPublish(req, res) {
        try {
            const { accountId } = req.params;
            const {
                target_group_jids,
                ad_library_id,
                custom_content,
                send_to_members = false,
                exclude_admins = true,
            } = req.body;

            if (!target_group_jids || target_group_jids.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب اختيار مجموعة واحدة على الأقل' });
            }

            const session = WhatsAppManager.getSession(accountId);
            if (!session) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب' });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);

            let messageContent = { text: custom_content || '', mediaPaths: [] };

            if (ad_library_id) {
                const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [ad_library_id]);
                if (ad) {
                    messageContent = this._buildMessageContent(ad);
                    await accountDB.run(
                        `UPDATE ad_library SET times_used = times_used + 1, last_used_at = NOW() WHERE id = $1`,
                        [ad_library_id]
                    );
                }
            }

            if (!messageContent.text && messageContent.mediaPaths.length === 0) {
                return res.status(400).json({ success: false, error: 'يجب إضافة نص أو وسائط للرسالة' });
            }

            const results = [];
            let membersSentTotal = 0;

            for (const jid of target_group_jids) {
                // 1️⃣ إرسال للمجموعة
                try {
                    await this._sendOne(session, jid, messageContent);
                    results.push({ jid, type: 'group', status: 'sent' });
                } catch (sendErr) {
                    results.push({ jid, type: 'group', status: 'failed', error: sendErr.message });
                }
                await new Promise(r => setTimeout(r, 1000));

                // 2️⃣ إرسال للأعضاء خاص (باستثناء المشرفين إذا كان الخيار مفعلاً)
                if (send_to_members) {
                    try {
                        const membersInfo = await WhatsAppManager.getGroupMembers(accountId, jid);
                        // members = non-admins always; add admins only if exclude_admins is false
                        const targets = exclude_admins
                            ? membersInfo.target_jids            // أعضاء فقط (بدون مشرفين)
                            : [...membersInfo.target_jids, ...membersInfo.admins];

                        for (const memberJid of targets) {
                            try {
                                await this._sendOne(session, memberJid, messageContent);
                                membersSentTotal++;
                                results.push({ jid: memberJid, type: 'private', status: 'sent', fromGroup: jid });
                            } catch (e) {
                                results.push({ jid: memberJid, type: 'private', status: 'failed', fromGroup: jid, error: e.message });
                            }
                            // تأخير بين الرسائل الخاصة لتجنب الحظر
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    } catch (membersErr) {
                        console.error(`[Broadcast] Failed to get members for ${jid}:`, membersErr.message);
                        results.push({ jid, type: 'members_fetch', status: 'failed', error: membersErr.message });
                    }
                }
            }

            // تسجيل في قاعدة البيانات
            const logId = crypto.randomUUID();
            const groupSentCount = results.filter(r => r.type === 'group' && r.status === 'sent').length;
            await accountDB.run(
                `INSERT INTO direct_publish_log 
                 (id, account_id, ad_library_id, target_group_jids, custom_content, status, send_to_members, exclude_admins, members_sent)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    logId, accountId, ad_library_id || null,
                    JSON.stringify(target_group_jids), custom_content || '',
                    groupSentCount === target_group_jids.length ? 'sent' : 'partial',
                    send_to_members ? true : false,
                    exclude_admins ? true : false,
                    membersSentTotal,
                ]
            );

            res.json({
                success: true,
                message: send_to_members
                    ? `تم الإرسال لـ ${groupSentCount} مجموعة + ${membersSentTotal} عضو (خاص)`
                    : `تم الإرسال لـ ${groupSentCount} من ${target_group_jids.length} مجموعة`,
                results,
            });
        } catch (err) {
            console.error('DirectPublish error:', err);
            res.status(500).json({ success: false, error: err.message || 'Internal Server Error' });
        }
    }

    async getDirectPublishLog(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const logs = await accountDB.all(
                `SELECT l.*, a.name as ad_name FROM direct_publish_log l 
                 LEFT JOIN ad_library a ON l.ad_library_id = a.id
                 WHERE l.account_id = $1 ORDER BY l.sent_at DESC LIMIT 100`,
                [accountId]
            );
            const parsed = logs.map(l => ({
                ...l,
                target_group_jids: JSON.parse(l.target_group_jids || '[]'),
            }));
            res.json({ success: true, logs: parsed });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new BroadcastController();
