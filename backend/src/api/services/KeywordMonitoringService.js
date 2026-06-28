'use strict';
/**
 * KeywordMonitoringService
 * خدمة مراقبة الكلمات المفتاحية في رسائل مجموعات واتساب
 */
const SystemDB  = require('../../database/SystemDB');
const SocketBridge = require('../../core/SocketBridge');

const KeywordMonitoringService = {

    // ── إدارة الكلمات المفتاحية ───────────────────────────────────────────

    async getKeywords(userId) {
        return await SystemDB.all(
            `SELECT * FROM kw_keywords WHERE user_id=$1 ORDER BY category, word`,
            [userId]
        );
    },

    async addKeyword(userId, { word, category = 'عام', case_sensitive = false, priority = 'normal', color = '#00A884' }) {
        const existing = await SystemDB.get(
            `SELECT id FROM kw_keywords WHERE user_id=$1 AND LOWER(word)=LOWER($2)`,
            [userId, word]
        );
        if (existing) throw new Error('الكلمة المفتاحية موجودة بالفعل');

        const row = await SystemDB.get(
            `INSERT INTO kw_keywords(user_id, word, category, case_sensitive, priority, color)
             VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
            [userId, word.trim(), category, case_sensitive, priority, color]
        );

        await this._logActivity(userId, 'add_keyword', `تمت إضافة الكلمة: ${word}`);
        return row;
    },

    async updateKeyword(userId, keywordId, updates) {
        const fields = [];
        const values = [];
        let idx = 1;

        if (updates.word       !== undefined) { fields.push(`word=$${idx++}`);           values.push(updates.word.trim()); }
        if (updates.category   !== undefined) { fields.push(`category=$${idx++}`);       values.push(updates.category); }
        if (updates.case_sensitive !== undefined) { fields.push(`case_sensitive=$${idx++}`); values.push(updates.case_sensitive); }
        if (updates.priority   !== undefined) { fields.push(`priority=$${idx++}`);       values.push(updates.priority); }
        if (updates.color      !== undefined) { fields.push(`color=$${idx++}`);          values.push(updates.color); }
        if (updates.is_active  !== undefined) { fields.push(`is_active=$${idx++}`);      values.push(updates.is_active); }

        if (!fields.length) throw new Error('لا توجد تحديثات');
        fields.push(`updated_at=NOW()`);
        values.push(keywordId, userId);

        const row = await SystemDB.get(
            `UPDATE kw_keywords SET ${fields.join(',')} WHERE id=$${idx++} AND user_id=$${idx} RETURNING *`,
            values
        );
        if (!row) throw new Error('الكلمة غير موجودة');

        await this._logActivity(userId, 'edit_keyword', `تم تعديل الكلمة: ${row.word}`);
        return row;
    },

    async deleteKeyword(userId, keywordId) {
        const row = await SystemDB.get(
            `DELETE FROM kw_keywords WHERE id=$1 AND user_id=$2 RETURNING word`,
            [keywordId, userId]
        );
        if (!row) throw new Error('الكلمة غير موجودة');
        await this._logActivity(userId, 'delete_keyword', `تم حذف الكلمة: ${row.word}`);
        return { success: true };
    },

    // ── التنبيهات ─────────────────────────────────────────────────────────

    async getAlerts(userId, { page = 1, limit = 20, keyword, group_name, status, phone, date_from, date_to } = {}) {
        const offset = (page - 1) * limit;
        const conditions = ['a.user_id=$1'];
        const values = [userId];
        let idx = 2;

        if (keyword) {
            conditions.push(`LOWER(a.matched_keyword) LIKE LOWER($${idx++})`);
            values.push(`%${keyword}%`);
        }
        if (group_name) {
            conditions.push(`LOWER(a.group_name) LIKE LOWER($${idx++})`);
            values.push(`%${group_name}%`);
        }
        if (status) {
            conditions.push(`a.status=$${idx++}`);
            values.push(status);
        }
        if (phone) {
            conditions.push(`a.sender_phone LIKE $${idx++}`);
            values.push(`%${phone}%`);
        }
        if (date_from) {
            conditions.push(`a.message_time >= $${idx++}`);
            values.push(new Date(date_from));
        }
        if (date_to) {
            conditions.push(`a.message_time <= $${idx++}`);
            values.push(new Date(date_to));
        }

        const where = conditions.join(' AND ');

        const total = await SystemDB.get(
            `SELECT COUNT(*) FROM kw_alerts a WHERE ${where}`,
            values
        );

        values.push(limit, offset);
        const rows = await SystemDB.all(
            `SELECT a.*, k.color as keyword_color, k.priority as keyword_priority
             FROM kw_alerts a
             LEFT JOIN kw_keywords k ON k.id=a.keyword_id
             WHERE ${where}
             ORDER BY a.message_time DESC
             LIMIT $${idx++} OFFSET $${idx}`,
            values
        );

        return {
            alerts: rows,
            total: parseInt(total?.count || 0),
            page,
            pages: Math.ceil(parseInt(total?.count || 0) / limit),
        };
    },

    async updateAlertStatus(userId, alertId, status, note = null) {
        const row = await SystemDB.get(
            `UPDATE kw_alerts SET status=$1, internal_note=COALESCE($2,internal_note), updated_at=NOW()
             WHERE id=$3 AND user_id=$4 RETURNING *`,
            [status, note, alertId, userId]
        );
        if (!row) throw new Error('التنبيه غير موجود');
        await this._logActivity(userId, status === 'reviewed' ? 'review_alert' : 'update_alert',
            `تم تحديث تنبيه: ${row.matched_keyword}`);
        return row;
    },

    async deleteAlert(userId, alertId) {
        const row = await SystemDB.get(
            `DELETE FROM kw_alerts WHERE id=$1 AND user_id=$2 RETURNING matched_keyword`,
            [alertId, userId]
        );
        if (!row) throw new Error('التنبيه غير موجود');
        await this._logActivity(userId, 'delete_alert', `تم حذف تنبيه: ${row.matched_keyword}`);
        return { success: true };
    },

    async addAlertNote(userId, alertId, note) {
        const row = await SystemDB.get(
            `UPDATE kw_alerts SET internal_note=$1, updated_at=NOW() WHERE id=$2 AND user_id=$3 RETURNING *`,
            [note, alertId, userId]
        );
        if (!row) throw new Error('التنبيه غير موجود');
        return row;
    },

    // ── الإحصائيات ────────────────────────────────────────────────────────

    async getStats(userId) {
        const [kwCount, todayCount, weekCount, topKeywords, topGroups, topSenders] = await Promise.all([
            SystemDB.get(`SELECT COUNT(*) FROM kw_keywords WHERE user_id=$1 AND is_active=TRUE`, [userId]),
            SystemDB.get(`SELECT COUNT(*) FROM kw_alerts WHERE user_id=$1 AND message_time >= NOW()-INTERVAL '1 day'`, [userId]),
            SystemDB.get(`SELECT COUNT(*) FROM kw_alerts WHERE user_id=$1 AND message_time >= NOW()-INTERVAL '7 days'`, [userId]),
            SystemDB.all(
                `SELECT matched_keyword, COUNT(*) as cnt FROM kw_alerts
                 WHERE user_id=$1 AND message_time >= NOW()-INTERVAL '7 days'
                 GROUP BY matched_keyword ORDER BY cnt DESC LIMIT 5`,
                [userId]
            ),
            SystemDB.all(
                `SELECT group_name, COUNT(*) as cnt FROM kw_alerts
                 WHERE user_id=$1 AND message_time >= NOW()-INTERVAL '7 days'
                 GROUP BY group_name ORDER BY cnt DESC LIMIT 5`,
                [userId]
            ),
            SystemDB.all(
                `SELECT sender_name, sender_phone, COUNT(*) as cnt FROM kw_alerts
                 WHERE user_id=$1 AND message_time >= NOW()-INTERVAL '7 days'
                 GROUP BY sender_name, sender_phone ORDER BY cnt DESC LIMIT 5`,
                [userId]
            ),
        ]);

        // مخطط بياني — آخر 7 أيام
        const dailyChart = await SystemDB.all(
            `SELECT DATE_TRUNC('day', message_time) as day, COUNT(*) as cnt
             FROM kw_alerts WHERE user_id=$1 AND message_time >= NOW()-INTERVAL '7 days'
             GROUP BY day ORDER BY day`,
            [userId]
        );

        return {
            keywords_count: parseInt(kwCount?.count || 0),
            today_count:    parseInt(todayCount?.count || 0),
            week_count:     parseInt(weekCount?.count || 0),
            top_keywords:   topKeywords,
            top_groups:     topGroups,
            top_senders:    topSenders,
            daily_chart:    dailyChart,
        };
    },

    // ── الإعدادات ─────────────────────────────────────────────────────────

    async getSettings(userId) {
        const row = await SystemDB.get(
            `SELECT settings FROM kw_settings WHERE user_id=$1`, [userId]
        );
        return row?.settings || this._defaultSettings();
    },

    async saveSettings(userId, settings) {
        await SystemDB.run(
            `INSERT INTO kw_settings(user_id, settings) VALUES($1,$2)
             ON CONFLICT(user_id) DO UPDATE SET settings=$2, updated_at=NOW()`,
            [userId, JSON.stringify(settings)]
        );
        return settings;
    },

    _defaultSettings() {
        return {
            monitoring_enabled: true,
            notifications_enabled: true,
            sound_enabled: true,
            sound_type: 'default',
            log_retention_days: 30,
        };
    },

    // ── سجل النشاط ───────────────────────────────────────────────────────

    async getActivityLog(userId, limit = 50) {
        return await SystemDB.all(
            `SELECT * FROM kw_activity_log WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2`,
            [userId, limit]
        );
    },

    async _logActivity(userId, action, details) {
        await SystemDB.run(
            `INSERT INTO kw_activity_log(user_id, action, details) VALUES($1,$2,$3)`,
            [userId, action, details]
        ).catch(() => {});
    },

    // ── كشف الكلمات المفتاحية في الرسائل ─────────────────────────────────

    async processIncomingMessage(accountId, userId, msg) {
        try {
            const settings = await this.getSettings(userId);
            if (!settings.monitoring_enabled) return;

            const keywords = await SystemDB.all(
                `SELECT * FROM kw_keywords WHERE user_id=$1 AND is_active=TRUE`, [userId]
            );
            if (!keywords.length) return;

            // استخراج نص الرسالة
            const m = msg.message;
            const text = (
                m?.conversation ||
                m?.extendedTextMessage?.text ||
                m?.imageMessage?.caption ||
                m?.videoMessage?.caption ||
                m?.documentMessage?.caption ||
                m?.buttonsResponseMessage?.selectedDisplayText ||
                m?.listResponseMessage?.title ||
                ''
            ).trim();

            if (!text) return;

            // التحقق من أن الرسالة من مجموعة
            const remoteJid = msg.key?.remoteJid || '';
            const isGroup = remoteJid.endsWith('@g.us');
            if (!isGroup) return;

            // اسم المرسل ورقمه
            const participantJid = msg.key?.participant || '';
            const senderPhone = participantJid.replace('@s.whatsapp.net', '').replace('@c.us', '');
            const senderName  = msg.pushName || senderPhone;
            const groupName   = remoteJid; // سيُستبدل باسم حقيقي لاحقاً إن أمكن

            // فحص كل كلمة مفتاحية
            for (const kw of keywords) {
                const word   = kw.word;
                const flags  = kw.case_sensitive ? 'g' : 'gi';
                let matched  = false;
                try {
                    matched = new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags).test(text);
                } catch {
                    matched = kw.case_sensitive
                        ? text.includes(word)
                        : text.toLowerCase().includes(word.toLowerCase());
                }

                if (!matched) continue;

                // حفظ التنبيه
                const alert = await SystemDB.get(
                    `INSERT INTO kw_alerts(
                        user_id, keyword_id, matched_keyword,
                        message_text, sender_name, sender_phone,
                        group_name, group_jid, account_id,
                        message_time, status
                     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'new') RETURNING *`,
                    [
                        userId, kw.id, word,
                        text, senderName, senderPhone,
                        groupName, remoteJid, accountId,
                        new Date(msg.messageTimestamp * 1000),
                    ]
                );

                // تحديث عداد المطابقات
                await SystemDB.run(
                    `UPDATE kw_keywords SET match_count=match_count+1 WHERE id=$1`, [kw.id]
                ).catch(() => {});

                // بث Socket.IO
                const payload = {
                    ...alert,
                    keyword_color:    kw.color,
                    keyword_priority: kw.priority,
                };
                SocketBridge.emit('keyword_alert', { userId, alert: payload });
                try {
                    const { _io } = require('../../index');
                    if (_io) _io.emit('keyword_alert', { userId, alert: payload });
                } catch {}
            }
        } catch (err) {
            console.error('[KWMonitor] processIncomingMessage error:', err.message);
        }
    },

    // ── تصدير الكلمات المفتاحية ───────────────────────────────────────────

    async exportKeywords(userId) {
        const rows = await SystemDB.all(
            `SELECT word, category, priority, color, case_sensitive FROM kw_keywords WHERE user_id=$1`, [userId]
        );
        return rows;
    },

    async importKeywords(userId, keywords) {
        let added = 0;
        for (const kw of keywords) {
            try {
                await this.addKeyword(userId, kw);
                added++;
            } catch { /* تجاهل التكرار */ }
        }
        return { added };
    },
};

module.exports = KeywordMonitoringService;
