'use strict';
/**
 * TelegramController — يدعم Bot Token + Real Long Polling
 */

const TelegramService = require('../services/TelegramService');
const { queryAll, queryOne, query } = require('../../lib/postgres');
const { v4: uuidv4 } = require('uuid');

const TelegramController = {

    // ── إضافة حساب تيليجرام ──────────────────────────────────────────────────
    async addAccount(req, res) {
        try {
            const { name, phone_number, api_id, api_hash, session_string, bot_token, notes } = req.body;
            const userId = req.user.id;

            if (!name) {
                return res.status(400).json({ success: false, error: 'اسم الحساب مطلوب' });
            }

            if (!bot_token && !session_string) {
                return res.status(400).json({ success: false, error: 'Bot Token مطلوب لتفعيل المراقبة الحقيقية' });
            }

            // التحقق من تكرار bot_token
            if (bot_token) {
                const existing = await queryOne(
                    `SELECT id FROM telegram_accounts WHERE bot_token = $1 AND user_id = $2`,
                    [bot_token, userId]
                );
                if (existing) {
                    return res.status(409).json({ success: false, error: 'هذا Bot Token مسجّل مسبقاً' });
                }
            }

            const id = uuidv4();
            await query(
                `INSERT INTO telegram_accounts
                 (id, user_id, name, phone_number, api_id, api_hash, session_string, bot_token, notes, status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'disconnected')`,
                [id, userId, name, phone_number || null, api_id || null, api_hash || null,
                 session_string || null, bot_token || null, notes || null]
            );

            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);

            // تشغيل الـ worker إذا كان هناك bot_token
            if (bot_token) {
                TelegramService.startWorker(account).catch(err => {
                    console.error('[TelegramController] startWorker error:', err.message);
                });
            }

            return res.json({ success: true, account });
        } catch (err) {
            console.error('[TelegramController.addAccount]', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── قائمة الحسابات ────────────────────────────────────────────────────────
    async listAccounts(req, res) {
        try {
            const userId  = req.user.id;
            const isAdmin = ['super_admin', 'admin'].includes(req.user.role);

            const accounts = isAdmin
                ? await queryAll(`SELECT * FROM telegram_accounts ORDER BY created_at DESC`)
                : await queryAll(
                    `SELECT * FROM telegram_accounts WHERE user_id = $1 ORDER BY created_at DESC`,
                    [userId]
                  );

            // إخفاء bot_token الكامل من الاستجابة (أمان)
            const safe = accounts.map(a => ({
                ...a,
                bot_token: a.bot_token ? `${a.bot_token.slice(0, 10)}...` : null,
                session_string: a.session_string ? '***' : null,
            }));

            return res.json({ success: true, accounts: safe });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تفاصيل حساب واحد ─────────────────────────────────────────────────────
    async getAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            // إخفاء bot_token
            account.bot_token = account.bot_token ? `${account.bot_token.slice(0, 10)}...` : null;
            return res.json({ success: true, account });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تعديل حساب ───────────────────────────────────────────────────────────
    async updateAccount(req, res) {
        try {
            const { id } = req.params;
            const { name, phone_number, api_id, api_hash, session_string, bot_token, notes } = req.body;

            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });

            await query(
                `UPDATE telegram_accounts SET
                 name=$1, phone_number=$2, api_id=$3, api_hash=$4,
                 session_string=$5, bot_token=$6, notes=$7, updated_at=NOW()
                 WHERE id=$8`,
                [
                    name           || account.name,
                    phone_number   !== undefined ? phone_number   : account.phone_number,
                    api_id         !== undefined ? api_id         : account.api_id,
                    api_hash       !== undefined ? api_hash       : account.api_hash,
                    session_string !== undefined ? session_string : account.session_string,
                    bot_token      !== undefined ? bot_token      : account.bot_token,
                    notes          !== undefined ? notes          : account.notes,
                    id,
                ]
            );

            // إعادة تشغيل الـ worker إذا تغيّر الـ bot_token
            const tokenChanged = bot_token && bot_token !== account.bot_token;
            if (tokenChanged) {
                TelegramService.stopWorker(id);
                const updated = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
                TelegramService.startWorker(updated).catch(err => {
                    console.error('[TelegramController] startWorker error (update):', err.message);
                });
            }

            const updated = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            updated.bot_token = updated.bot_token ? `${updated.bot_token.slice(0, 10)}...` : null;
            return res.json({ success: true, account: updated });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حذف حساب ─────────────────────────────────────────────────────────────
    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });

            TelegramService.stopWorker(id);
            await query(`DELETE FROM telegram_accounts WHERE id = $1`, [id]);

            return res.json({ success: true, message: 'تم حذف الحساب' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تشغيل worker ─────────────────────────────────────────────────────────
    async startWorker(req, res) {
        try {
            const { id } = req.params;
            const account = await queryOne(`SELECT * FROM telegram_accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            if (!account.bot_token) {
                return res.status(400).json({ success: false, error: 'لا يوجد Bot Token للحساب. أضف Bot Token أولاً من @BotFather' });
            }

            await TelegramService.startWorker(account);
            return res.json({ success: true, message: 'تم تشغيل المراقبة الحقيقية' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── إيقاف worker ─────────────────────────────────────────────────────────
    async stopWorker(req, res) {
        try {
            const { id } = req.params;
            TelegramService.stopWorker(id);
            return res.json({ success: true, message: 'تم إيقاف المراقبة' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── استقبال رسائل من سكريبت Python (telethon/pyrogram) ─────────────────
    async receiveIngest(req, res) {
        try {
            const { accountId } = req.params;
            const { messages = [], secret, text, group_name } = req.body;

            const expectedSecret = process.env.TELEGRAM_INGEST_SECRET;
            if (expectedSecret && secret !== expectedSecret) {
                return res.status(401).json({ success: false, error: 'Unauthorized' });
            }

            const account = await queryOne(
                `SELECT id, name FROM telegram_accounts WHERE id = $1`, [accountId]
            );
            if (!account) {
                return res.status(404).json({ success: false, error: 'الحساب غير موجود' });
            }

            let totalLinks = 0;
            const items = messages.length > 0
                ? messages
                : (text ? [{ text, group_name: group_name || '' }] : []);

            for (const item of items) {
                if (!item.text) continue;
                const result = await TelegramService.processIncomingMessage(
                    accountId,
                    account.name,
                    item.group_name || item.channel || '',
                    item.text
                );
                totalLinks += result?.linksSaved || 0;
            }

            return res.json({ success: true, linksAdded: totalLinks });
        } catch (err) {
            console.error('[TelegramController.receiveIngest]', err.message);
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── استقبال تحديثات Telegram Bot API (webhook) ──────────────────────────
    async receiveBotWebhook(req, res) {
        res.json({ ok: true });
        try {
            const { accountId } = req.params;
            const update = req.body;
            if (!update) return;
            await TelegramService.processBotUpdate(accountId, update);
        } catch (err) {
            console.error('[TelegramController.receiveBotWebhook]', err.message);
        }
    },

    // ── روابط واتساب المكتشفة ────────────────────────────────────────────────
    async listLinks(req, res) {
        try {
            const { page = 1, limit = 50, status, account_id, date_from, date_to, search } = req.query;
            const offset = (parseInt(page) - 1) * parseInt(limit);

            const conditions = [];
            const params     = [];
            let pIdx = 1;

            conditions.push(`wl.deleted = false`);

            if (status)     { conditions.push(`wl.status = $${pIdx++}`);             params.push(status); }
            if (account_id) { conditions.push(`wl.source_account_id = $${pIdx++}`);  params.push(account_id); }
            if (date_from)  { conditions.push(`wl.discovered_at >= $${pIdx++}`);     params.push(date_from); }
            if (date_to)    { conditions.push(`wl.discovered_at <= $${pIdx++}`);     params.push(date_to); }
            if (search)     { conditions.push(`wl.whatsapp_link ILIKE $${pIdx++}`);  params.push(`%${search}%`); }

            const where = `WHERE ${conditions.join(' AND ')}`;

            const total = await queryOne(
                `SELECT COUNT(*) as cnt FROM whatsapp_links wl ${where}`,
                params
            );

            const links = await queryAll(
                `SELECT wl.*, ta.name as account_name, ta.phone_number as account_phone
                 FROM whatsapp_links wl
                 LEFT JOIN telegram_accounts ta ON ta.id = wl.source_account_id
                 ${where}
                 ORDER BY wl.discovered_at DESC
                 LIMIT $${pIdx++} OFFSET $${pIdx++}`,
                [...params, parseInt(limit), offset]
            );

            return res.json({
                success: true,
                links,
                total:   parseInt(total?.cnt || 0),
                page:    parseInt(page),
                limit:   parseInt(limit),
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تحديث حالة رابط ──────────────────────────────────────────────────────
    async updateLinkStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, joined, copied, notes } = req.body;

            const sets   = [];
            const params = [];
            let idx = 1;

            if (status !== undefined) { sets.push(`status=$${idx++}`);  params.push(status); }
            if (joined !== undefined) { sets.push(`joined=$${idx++}`);  params.push(joined); }
            if (copied !== undefined) { sets.push(`copied=$${idx++}`);  params.push(copied); }
            if (notes  !== undefined) { sets.push(`notes=$${idx++}`);   params.push(notes); }

            if (!sets.length) {
                return res.status(400).json({ success: false, error: 'لا توجد بيانات للتحديث' });
            }

            params.push(id);
            await query(`UPDATE whatsapp_links SET ${sets.join(',')} WHERE id=$${idx}`, params);

            return res.json({ success: true });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حذف رابط (soft delete) ───────────────────────────────────────────────
    async deleteLink(req, res) {
        try {
            const { id } = req.params;
            await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE id=$1`, [id]);
            return res.json({ success: true });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حذف متعدد ────────────────────────────────────────────────────────────
    async bulkDeleteLinks(req, res) {
        try {
            const { ids, deleteJoined } = req.body;

            if (deleteJoined) {
                await query(`UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE joined=true`);
                return res.json({ success: true });
            }
            if (ids && Array.isArray(ids) && ids.length) {
                await query(
                    `UPDATE whatsapp_links SET deleted=true, status='deleted' WHERE id = ANY($1::uuid[])`,
                    [ids]
                );
                return res.json({ success: true });
            }
            return res.status(400).json({ success: false, error: 'يرجى تحديد روابط للحذف' });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── تصدير CSV ────────────────────────────────────────────────────────────
    async exportLinks(req, res) {
        try {
            const { status, account_id } = req.query;
            const conditions = ['deleted = false'];
            const params     = [];
            let pIdx = 1;

            if (status)     { conditions.push(`status = $${pIdx++}`);            params.push(status); }
            if (account_id) { conditions.push(`source_account_id = $${pIdx++}`); params.push(account_id); }

            const links = await queryAll(
                `SELECT whatsapp_link, source_account_name, source_group,
                        discovered_at, status, duplicate_count, joined
                 FROM whatsapp_links
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY discovered_at DESC`,
                params
            );

            const header = 'رابط واتساب,الحساب المصدر,المجموعة/القناة,تاريخ الاكتشاف,الحالة,عدد التكرار,تم الانضمام';
            const rows   = links.map(l =>
                `"${l.whatsapp_link}","${l.source_account_name || ''}","${l.source_group || ''}",` +
                `"${l.discovered_at}","${l.status}","${l.duplicate_count}","${l.joined ? 'نعم' : 'لا'}"`
            );
            const csv = '\uFEFF' + [header, ...rows].join('\n');

            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', 'attachment; filename=whatsapp_links.csv');
            return res.send(csv);
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── إحصائيات ─────────────────────────────────────────────────────────────
    async getStats(req, res) {
        try {
            const totalAccounts     = await queryOne(`SELECT COUNT(*) as cnt FROM telegram_accounts`);
            const connectedAccounts = await queryOne(`SELECT COUNT(*) as cnt FROM telegram_accounts WHERE status='connected'`);
            const totalLinks        = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE deleted=false`);
            const newLinks          = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE deleted=false AND discovered_at >= NOW() - INTERVAL '24 hours'`);
            const joinedLinks       = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE joined=true AND deleted=false`);
            const deletedLinks      = await queryOne(`SELECT COUNT(*) as cnt FROM whatsapp_links WHERE deleted=true`);
            const duplicateLinks    = await queryOne(`SELECT COALESCE(SUM(duplicate_count),0) as cnt FROM whatsapp_links WHERE duplicate_count > 0`);

            const perAccount = await queryAll(
                `SELECT ta.id, ta.name, ta.phone_number, ta.bot_username, COUNT(wl.id) as links_count
                 FROM telegram_accounts ta
                 LEFT JOIN whatsapp_links wl ON wl.source_account_id = ta.id AND wl.deleted=false
                 GROUP BY ta.id, ta.name, ta.phone_number, ta.bot_username
                 ORDER BY links_count DESC`
            );

            // حالة الـ workers النشطة
            const workers = TelegramService.getAllWorkersStatus();

            return res.json({
                success: true,
                stats: {
                    totalAccounts:        parseInt(totalAccounts?.cnt    || 0),
                    connectedAccounts:    parseInt(connectedAccounts?.cnt || 0),
                    disconnectedAccounts: parseInt(totalAccounts?.cnt    || 0) - parseInt(connectedAccounts?.cnt || 0),
                    totalLinks:           parseInt(totalLinks?.cnt       || 0),
                    newLinks:             parseInt(newLinks?.cnt         || 0),
                    joinedLinks:          parseInt(joinedLinks?.cnt      || 0),
                    deletedLinks:         parseInt(deletedLinks?.cnt     || 0),
                    duplicateLinks:       parseInt(duplicateLinks?.cnt   || 0),
                    perAccount,
                    activeWorkers:        workers.length,
                },
            });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },

    // ── حالة الـ workers ──────────────────────────────────────────────────────
    async getWorkersStatus(req, res) {
        try {
            const workers = TelegramService.getAllWorkersStatus();
            return res.json({ success: true, workers });
        } catch (err) {
            return res.status(500).json({ success: false, error: err.message });
        }
    },
};

module.exports = TelegramController;
