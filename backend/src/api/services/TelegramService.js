'use strict';
/**
 * TelegramService — مراقبة حقيقية عبر Telegram Bot API (long polling)
 *
 * كيف يعمل:
 *  - كل حساب يُضاف يحتاج bot_token (من @BotFather)
 *  - البوت يُضاف إلى القنوات/المجموعات المراد مراقبتها
 *  - الـ worker يقوم بـ long polling حقيقي عبر getUpdates
 *  - كل رسالة تُفحص عن روابط واتساب وتُحفظ في قاعدة البيانات
 *  - يدعم أيضاً: webhook (POST /api/telegram/webhook/:accountId)
 *               و ingest من Python (POST /api/telegram/ingest/:accountId)
 */

const https = require('https');
const { query, queryOne, queryAll } = require('../../lib/postgres');
const { v4: uuidv4 } = require('uuid');
const SocketBridge = require('../../core/SocketBridge');

// ── Regex لاكتشاف روابط واتساب ──────────────────────────────────────────────
const WA_LINK_PATTERN = /https?:\/\/(?:chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com\/send)[^\s\])"'>]*/gi;

// ── خريطة الـ Workers النشطة ──────────────────────────────────────────────────
const activeWorkers = new Map(); // accountId → { account, status, ... }

// ── طلب HTTPS بسيط بدون مكتبات خارجية ──────────────────────────────────────
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
            });
        });
        req.on('error', reject);
        req.setTimeout(35000, () => { req.destroy(); reject(new Error('Request timeout')); });
    });
}

// ── بناء URL الـ Telegram Bot API ───────────────────────────────────────────
function telegramUrl(botToken, method, params = {}) {
    const qs = Object.entries(params)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join('&');
    return `https://api.telegram.org/bot${botToken}/${method}${qs ? '?' + qs : ''}`;
}

// ── التحقق من صحة الـ Bot Token ──────────────────────────────────────────────
async function validateBotToken(botToken) {
    try {
        const url = telegramUrl(botToken, 'getMe');
        const result = await httpsGet(url);
        return result?.ok ? result.result : null;
    } catch {
        return null;
    }
}

const TelegramService = {

    // ── تشغيل worker لحساب واحد ─────────────────────────────────────────────
    async startWorker(account) {
        const id = account.id;

        if (activeWorkers.has(id)) {
            console.log(`[TelegramService] Worker ${id} already running`);
            return;
        }

        // التحقق من وجود bot_token
        if (!account.bot_token) {
            console.warn(`[TelegramService] Account ${account.name} has no bot_token — skipping real polling`);
            await query(
                `UPDATE telegram_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`,
                [id]
            ).catch(() => {});
            return;
        }

        console.log(`[TelegramService] Starting real polling worker for: ${account.name}`);

        // التحقق من صحة الـ Bot Token
        const botInfo = await validateBotToken(account.bot_token);
        if (!botInfo) {
            console.error(`[TelegramService] Invalid bot_token for account: ${account.name}`);
            await query(
                `UPDATE telegram_accounts SET status='error', updated_at=NOW() WHERE id=$1`,
                [id]
            ).catch(() => {});
            SocketBridge.emit('telegram:worker_error', {
                accountId: id,
                accountName: account.name,
                error: 'Bot token غير صالح',
            });
            return;
        }

        console.log(`[TelegramService] Bot verified: @${botInfo.username} for account: ${account.name}`);

        const workerState = {
            account,
            botInfo,
            status:     'running',
            startedAt:  new Date(),
            linksFound: 0,
            lastCheck:  null,
            error:      null,
            offset:     0,       // آخر update_id معالج
            active:     true,    // للتحكم في إيقاف الـ loop
        };

        // تحديث الحالة في قاعدة البيانات
        await query(
            `UPDATE telegram_accounts SET status='connected', bot_username=$2, last_activity_at=NOW(), updated_at=NOW() WHERE id=$1`,
            [id, botInfo.username]
        ).catch(err => {
            // إذا لم يكن العمود موجوداً (migrations قديمة)، نحدث بدونه
            query(
                `UPDATE telegram_accounts SET status='connected', last_activity_at=NOW(), updated_at=NOW() WHERE id=$1`,
                [id]
            ).catch(() => {});
        });

        activeWorkers.set(id, workerState);

        SocketBridge.emit('telegram:worker_started', {
            accountId:   id,
            accountName: account.name,
            botUsername: botInfo.username,
        });

        // بدء Long Polling في الخلفية
        TelegramService._longPollLoop(id, workerState).catch(err => {
            console.error(`[TelegramService] Long poll loop crashed for ${account.name}:`, err.message);
        });
    },

    // ── حلقة Long Polling الحقيقية ──────────────────────────────────────────
    async _longPollLoop(accountId, state) {
        console.log(`[TelegramService] Long poll loop started for account: ${state.account.name}`);

        while (state.active && activeWorkers.has(accountId)) {
            try {
                state.lastCheck = new Date();

                // جلب التحديثات مع long polling (timeout=30 ثانية)
                const url = telegramUrl(state.account.bot_token, 'getUpdates', {
                    offset:          state.offset,
                    timeout:         30,
                    limit:           100,
                    allowed_updates: 'message,channel_post,edited_message,edited_channel_post',
                });

                const result = await httpsGet(url);

                if (!state.active || !activeWorkers.has(accountId)) break;

                if (!result?.ok) {
                    const errDesc = result?.description || 'Unknown Telegram API error';
                    console.error(`[TelegramService] getUpdates error for ${state.account.name}:`, errDesc);
                    state.error = errDesc;

                    // إذا كان الـ token معطّلاً، أوقف الـ worker
                    if (result?.error_code === 401) {
                        console.error(`[TelegramService] Bot token revoked for ${state.account.name}`);
                        break;
                    }

                    // انتظر قبل المحاولة مجدداً
                    await TelegramService._sleep(5000);
                    continue;
                }

                const updates = result.result || [];

                if (updates.length > 0) {
                    // معالجة كل تحديث
                    for (const update of updates) {
                        await TelegramService._processUpdate(accountId, state, update);
                        // تحديث الـ offset لتجنب إعادة معالجة نفس التحديث
                        state.offset = update.update_id + 1;
                    }

                    // تحديث last_activity في DB
                    await query(
                        `UPDATE telegram_accounts SET last_activity_at=NOW() WHERE id=$1`,
                        [accountId]
                    ).catch(() => {});
                }

            } catch (err) {
                if (!state.active || !activeWorkers.has(accountId)) break;
                state.error = err.message;
                console.error(`[TelegramService] Poll error for ${state.account.name}:`, err.message);
                // انتظر 5 ثوانٍ قبل إعادة المحاولة
                await TelegramService._sleep(5000);
            }
        }

        console.log(`[TelegramService] Long poll loop ended for: ${state.account.name}`);

        // تحديث الحالة في DB عند الإيقاف
        await query(
            `UPDATE telegram_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`,
            [accountId]
        ).catch(() => {});
    },

    // ── معالجة تحديث واحد من Telegram ──────────────────────────────────────
    async _processUpdate(accountId, state, update) {
        try {
            // استخراج الرسالة (رسالة عادية، منشور قناة، رسالة معدّلة)
            const msg = update.message
                || update.channel_post
                || update.edited_message
                || update.edited_channel_post;

            if (!msg) return;

            // نصوص فقط (text أو caption للصور/الفيديو)
            const text = msg.text || msg.caption || '';
            if (!text) return;

            // اسم المجموعة/القناة
            const chatTitle  = msg.chat?.title || msg.chat?.username || String(msg.chat?.id || '');
            const chatType   = msg.chat?.type  || 'unknown';
            const sourceGroup = `${chatTitle} (${chatType})`;

            // البحث عن روابط واتساب في النص
            const rawLinks = text.match(WA_LINK_PATTERN) || [];

            let saved = 0;
            for (const raw of rawLinks) {
                // تنظيف الرابط
                const link = raw.trim().replace(/[.,;:!?'")\]}]+$/, '');
                if (!link) continue;

                const result = await TelegramService.saveLink({
                    whatsapp_link:       link,
                    source_account_id:   accountId,
                    source_account_name: state.account.name,
                    source_group:        sourceGroup,
                });

                if (!result.isDuplicate) saved++;
            }

            // تحديث عدد الروابط في الـ worker state
            if (rawLinks.length > 0) {
                state.linksFound += rawLinks.length;
                state.error = null; // مسح أي خطأ سابق عند نجاح المعالجة

                console.log(
                    `[TelegramService] Account "${state.account.name}" — ` +
                    `found ${rawLinks.length} link(s) in "${chatTitle}", saved ${saved} new`
                );
            }

        } catch (err) {
            console.error(`[TelegramService] _processUpdate error:`, err.message);
        }
    },

    // ── إيقاف worker ─────────────────────────────────────────────────────────
    stopWorker(accountId) {
        const worker = activeWorkers.get(accountId);
        if (!worker) return;

        worker.active = false; // إيقاف حلقة الـ polling
        activeWorkers.delete(accountId);

        query(
            `UPDATE telegram_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`,
            [accountId]
        ).catch(() => {});

        SocketBridge.emit('telegram:worker_stopped', { accountId });
        console.log(`[TelegramService] Worker stopped: ${accountId}`);
    },

    // ── إيقاف جميع الـ workers ───────────────────────────────────────────────
    stopAll() {
        for (const [id] of activeWorkers) {
            this.stopWorker(id);
        }
    },

    // ── حالة جميع الـ workers ────────────────────────────────────────────────
    getAllWorkersStatus() {
        const result = [];
        for (const [id, state] of activeWorkers) {
            result.push({
                accountId:   id,
                accountName: state.account.name,
                botUsername: state.botInfo?.username || null,
                status:      state.status,
                startedAt:   state.startedAt,
                linksFound:  state.linksFound,
                lastCheck:   state.lastCheck,
                error:       state.error,
                offset:      state.offset,
            });
        }
        return result;
    },

    // ── استقبال رسالة واحدة (webhook / سكريبت Python خارجي) ─────────────────
    async processIncomingMessage(accountId, accountName, channelOrGroup, message) {
        if (!message || typeof message !== 'string') return;
        try {
            const links = message.match(WA_LINK_PATTERN) || [];
            let saved = 0;
            for (const raw of links) {
                const link = raw.trim().replace(/[.,;:!?'")\]}]+$/, '');
                const result = await TelegramService.saveLink({
                    whatsapp_link:       link,
                    source_account_id:   accountId,
                    source_account_name: accountName,
                    source_group:        channelOrGroup,
                });
                if (!result.isDuplicate) saved++;
            }

            const worker = activeWorkers.get(accountId);
            if (worker && saved > 0) worker.linksFound += saved;

            return { linksFound: links.length, linksSaved: saved };
        } catch (err) {
            console.error('[TelegramService.processIncomingMessage]', err.message);
            return { linksFound: 0, linksSaved: 0 };
        }
    },

    // ── معالجة تحديث Telegram Bot API (webhook) ─────────────────────────────
    async processBotUpdate(accountId, update) {
        try {
            const account = await queryOne(
                `SELECT id, name FROM telegram_accounts WHERE id = $1`, [accountId]
            );
            if (!account) return;

            // إذا كان الـ worker نشطاً، لا تُعيد المعالجة (تجنب التكرار)
            const worker = activeWorkers.get(accountId);
            if (worker) {
                // الـ worker النشط يعالج التحديثات بنفسه عبر polling
                // webhook يُستخدم فقط عندما لا يكون polling نشطاً
                return;
            }

            const msg = update.message || update.channel_post || update.edited_message;
            if (!msg?.text) return;

            const group = msg.chat?.title || msg.chat?.username || String(msg.chat?.id || '');
            await TelegramService.processIncomingMessage(
                accountId, account.name, group, msg.text
            );
        } catch (err) {
            console.error('[TelegramService.processBotUpdate]', err.message);
        }
    },

    // ── حفظ رابط مع منع التكرار ─────────────────────────────────────────────
    async saveLink({ whatsapp_link, source_account_id, source_account_name, source_group }) {
        try {
            const existing = await queryOne(
                `SELECT id, duplicate_count FROM whatsapp_links WHERE whatsapp_link = $1`,
                [whatsapp_link]
            );

            if (existing) {
                await query(
                    `UPDATE whatsapp_links SET
                     duplicate_count     = duplicate_count + 1,
                     last_seen           = NOW(),
                     source_account_id   = $2,
                     source_account_name = $3,
                     source_group        = $4,
                     updated_at          = NOW()
                     WHERE id = $1`,
                    [existing.id, source_account_id, source_account_name, source_group]
                );
                SocketBridge.emit('telegram:link_duplicate', {
                    linkId:          existing.id,
                    whatsapp_link,
                    duplicate_count: existing.duplicate_count + 1,
                });
                return { isDuplicate: true, id: existing.id };
            }

            const id = uuidv4();
            await query(
                `INSERT INTO whatsapp_links
                 (id, whatsapp_link, source_account_id, source_account_name, source_group,
                  discovered_at, last_seen, duplicate_count, status, joined, copied, deleted)
                 VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),0,'new',false,false,false)`,
                [id, whatsapp_link, source_account_id, source_account_name, source_group]
            );

            const link = await queryOne(`SELECT * FROM whatsapp_links WHERE id = $1`, [id]);
            SocketBridge.emit('telegram:new_link', link);

            if (source_account_id) {
                query(
                    `UPDATE telegram_accounts
                     SET links_collected = links_collected + 1, last_activity_at = NOW()
                     WHERE id = $1`,
                    [source_account_id]
                ).catch(() => {});
            }

            return { isDuplicate: false, id };
        } catch (err) {
            console.error('[TelegramService.saveLink]', err.message);
            throw err;
        }
    },

    // ── تشغيل جميع الحسابات عند بدء الخادم ──────────────────────────────────
    async initAllWorkers() {
        try {
            const accounts = await queryAll(
                `SELECT * FROM telegram_accounts
                 WHERE bot_token IS NOT NULL AND status != 'disabled'`
            );
            for (const acc of accounts) {
                await this.startWorker(acc).catch(err =>
                    console.error(`[TelegramService] Failed to start worker for ${acc.name}:`, err.message)
                );
                await TelegramService._sleep(1000); // فاصل بين كل worker
            }
            console.log(`[TelegramService] Initialized ${accounts.length} workers`);
        } catch (err) {
            console.error('[TelegramService.initAllWorkers]', err.message);
        }
    },

    // ── دالة مساعدة: sleep ───────────────────────────────────────────────────
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    },
};

module.exports = TelegramService;
