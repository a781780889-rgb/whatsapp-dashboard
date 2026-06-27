'use strict';
/**
 * TelegramService — مراقبة حقيقية عبر Telegram MTProto (gramjs)
 *
 * يعمل بحساب المستخدم العادي (لا يحتاج Admin):
 *  - يقرأ الرسائل من جميع القنوات/المجموعات التي أنت عضو فيها
 *  - يستخدم api_id + api_hash + session_string من my.telegram.org
 *  - يكتشف روابط واتساب ويحفظها في قاعدة البيانات
 *
 * للحصول على session_string:
 *  - سجّل دخولك مرة واحدة عبر سكريبت gen_session.js (مرفق)
 *  - انسخ الـ string الناتج وضعه في حقل session_string عند إضافة الحساب
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const { v4: uuidv4 } = require('uuid');
const SocketBridge = require('../../core/SocketBridge');

// ── Regex روابط واتساب ───────────────────────────────────────────────────────
const WA_LINK_PATTERN = /https?:\/\/(?:chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com\/send)[^\s\])"'>]*/gi;

// ── خريطة الـ Workers النشطة ──────────────────────────────────────────────────
const activeWorkers = new Map(); // accountId → workerState

// ── تحميل gramjs بشكل آمن ───────────────────────────────────────────────────
let TelegramClient, StringSession;
try {
    const telegramLib = require('telegram');
    TelegramClient  = telegramLib.TelegramClient;
    StringSession   = require('telegram').sessions.StringSession;
    console.log('[TelegramService] gramjs loaded ✓');
} catch (e) {
    console.warn('[TelegramService] gramjs not installed. Run: npm install telegram');
}

const TelegramService = {

    // ── تشغيل worker لحساب واحد ─────────────────────────────────────────────
    async startWorker(account) {
        const id = account.id;

        if (activeWorkers.has(id)) {
            console.log(`[TelegramService] Worker ${id} already running`);
            return;
        }

        if (!TelegramClient) {
            console.error('[TelegramService] gramjs not installed. Run: npm install telegram');
            await query(
                `UPDATE telegram_accounts SET status='error', updated_at=NOW() WHERE id=$1`, [id]
            ).catch(() => {});
            return;
        }

        if (!account.api_id || !account.api_hash || !account.session_string) {
            console.warn(`[TelegramService] Account ${account.name} missing api_id/api_hash/session_string`);
            await query(
                `UPDATE telegram_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [id]
            ).catch(() => {});
            return;
        }

        console.log(`[TelegramService] Starting MTProto worker for: ${account.name}`);

        const workerState = {
            account,
            client:     null,
            status:     'connecting',
            startedAt:  new Date(),
            linksFound: 0,
            lastCheck:  null,
            error:      null,
            active:     true,
        };

        activeWorkers.set(id, workerState);

        // بدء الاتصال في الخلفية
        TelegramService._connectAndListen(id, workerState).catch(err => {
            console.error(`[TelegramService] Worker crashed for ${account.name}:`, err.message);
            workerState.status = 'error';
            workerState.error  = err.message;
        });
    },

    // ── الاتصال والاستماع ────────────────────────────────────────────────────
    async _connectAndListen(accountId, state) {
        const account = state.account;

        try {
            const session = new StringSession(account.session_string);
            const client  = new TelegramClient(
                session,
                parseInt(account.api_id),
                account.api_hash,
                {
                    connectionRetries: 5,
                    retryDelay:        3000,
                    autoReconnect:     true,
                    // لا نطلب إدخال من المستخدم — نستخدم session_string موجود
                    baseLogger: { // إخفاء logs التيليجرام الطويلة
                        error:  (...a) => console.error('[gramjs]', ...a),
                        warn:   () => {},
                        info:   () => {},
                        debug:  () => {},
                    },
                }
            );

            state.client = client;

            // الاتصال بدون طلب code (session موجود)
            await client.connect();

            if (!await client.isUserAuthorized()) {
                throw new Error('Session غير صالح — أعد إنشاء session_string');
            }

            const me = await client.getMe();
            console.log(`[TelegramService] Connected as: ${me.username || me.phone} for account "${account.name}"`);

            // تحديث الحالة
            state.status = 'running';
            await query(
                `UPDATE telegram_accounts
                 SET status='connected', last_activity_at=NOW(), updated_at=NOW()
                 WHERE id=$1`,
                [accountId]
            ).catch(() => {});

            SocketBridge.emit('telegram:worker_started', {
                accountId:   accountId,
                accountName: account.name,
                phone:       me.phone || '',
                username:    me.username || '',
            });

            // ── الاستماع للرسائل الجديدة (real-time) ───────────────────────
            const { NewMessage } = require('telegram/events');

            client.addEventHandler(async (event) => {
                if (!state.active) return;

                try {
                    const msg  = event.message;
                    const text = msg?.text || msg?.message || '';
                    if (!text) return;

                    state.lastCheck = new Date();

                    // اسم المجموعة/القناة
                    let sourceGroup = '';
                    try {
                        const chat = await event.getChat();
                        sourceGroup = chat?.title || chat?.username || String(chat?.id || '');
                    } catch {
                        sourceGroup = String(msg?.peerId?.channelId || msg?.peerId?.chatId || '');
                    }

                    const rawLinks = text.match(WA_LINK_PATTERN) || [];
                    let saved = 0;

                    for (const raw of rawLinks) {
                        const link = raw.trim().replace(/[.,;:!?'")\]}]+$/, '');
                        if (!link) continue;

                        const result = await TelegramService.saveLink({
                            whatsapp_link:       link,
                            source_account_id:   accountId,
                            source_account_name: account.name,
                            source_group:        sourceGroup,
                        });
                        if (!result.isDuplicate) saved++;
                    }

                    if (rawLinks.length > 0) {
                        state.linksFound += rawLinks.length;
                        console.log(
                            `[TelegramService] "${account.name}" — ` +
                            `found ${rawLinks.length} link(s) in "${sourceGroup}", saved ${saved} new`
                        );
                        // تحديث last_activity
                        query(
                            `UPDATE telegram_accounts SET last_activity_at=NOW() WHERE id=$1`,
                            [accountId]
                        ).catch(() => {});
                    }
                } catch (err) {
                    console.error(`[TelegramService] Message handler error:`, err.message);
                }
            }, new NewMessage({}));

            // ── مسح الرسائل القديمة عند الاتصال (اختياري) ──────────────────
            // يمكن تفعيله لجلب روابط من الرسائل السابقة
            if (process.env.TELEGRAM_SCAN_HISTORY === 'true') {
                await TelegramService._scanHistory(client, account, accountId).catch(err => {
                    console.warn(`[TelegramService] History scan failed:`, err.message);
                });
            }

            // إبقاء الـ client مفتوحاً حتى يُطلب الإيقاف
            await client.disconnected;

        } catch (err) {
            if (!state.active) return; // تم الإيقاف عمداً

            state.status = 'error';
            state.error  = err.message;
            console.error(`[TelegramService] Connection error for "${account.name}":`, err.message);

            await query(
                `UPDATE telegram_accounts SET status='error', updated_at=NOW() WHERE id=$1`,
                [accountId]
            ).catch(() => {});

            SocketBridge.emit('telegram:worker_error', {
                accountId:   accountId,
                accountName: account.name,
                error:       err.message,
            });

            // إعادة المحاولة بعد 60 ثانية
            if (state.active && activeWorkers.has(accountId)) {
                console.log(`[TelegramService] Retrying "${account.name}" in 60s...`);
                await TelegramService._sleep(60000);
                if (state.active && activeWorkers.has(accountId)) {
                    await TelegramService._connectAndListen(accountId, state).catch(() => {});
                }
            }
        }
    },

    // ── مسح الرسائل التاريخية (إذا كان TELEGRAM_SCAN_HISTORY=true) ──────────
    async _scanHistory(client, account, accountId) {
        console.log(`[TelegramService] Scanning history for "${account.name}"...`);
        const dialogs = await client.getDialogs({ limit: 200 });
        let totalFound = 0;

        for (const dialog of dialogs) {
            if (!dialog.isGroup && !dialog.isChannel) continue;
            try {
                const messages = await client.getMessages(dialog.entity, {
                    limit: 100,
                    filter: undefined,
                });
                for (const msg of messages) {
                    const text = msg?.text || msg?.message || '';
                    if (!text) continue;
                    const rawLinks = text.match(WA_LINK_PATTERN) || [];
                    for (const raw of rawLinks) {
                        const link = raw.trim().replace(/[.,;:!?'")\]}]+$/, '');
                        if (!link) continue;
                        const result = await TelegramService.saveLink({
                            whatsapp_link:       link,
                            source_account_id:   accountId,
                            source_account_name: account.name,
                            source_group:        dialog.title || dialog.name || '',
                        });
                        if (!result.isDuplicate) totalFound++;
                    }
                }
            } catch { /* تجاهل القنوات التي لا يمكن قراءتها */ }
        }
        console.log(`[TelegramService] History scan done: ${totalFound} new links for "${account.name}"`);
    },

    // ── إيقاف worker ─────────────────────────────────────────────────────────
    stopWorker(accountId) {
        const worker = activeWorkers.get(accountId);
        if (!worker) return;

        worker.active = false;

        // قطع اتصال الـ client
        if (worker.client) {
            worker.client.disconnect().catch(() => {});
        }

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
                status:      state.status,
                startedAt:   state.startedAt,
                linksFound:  state.linksFound,
                lastCheck:   state.lastCheck,
                error:       state.error,
            });
        }
        return result;
    },

    // ── استقبال رسالة من Python / webhook خارجي ─────────────────────────────
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

    // ── معالجة webhook من Telegram Bot API ──────────────────────────────────
    async processBotUpdate(accountId, update) {
        try {
            const account = await queryOne(
                `SELECT id, name FROM telegram_accounts WHERE id = $1`, [accountId]
            );
            if (!account) return;
            const msg = update.message || update.channel_post || update.edited_message;
            if (!msg?.text) return;
            const group = msg.chat?.title || msg.chat?.username || String(msg.chat?.id || '');
            await TelegramService.processIncomingMessage(accountId, account.name, group, msg.text);
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
                 WHERE session_string IS NOT NULL
                   AND api_id IS NOT NULL
                   AND api_hash IS NOT NULL
                   AND status != 'disabled'`
            );
            for (const acc of accounts) {
                await this.startWorker(acc).catch(err =>
                    console.error(`[TelegramService] Failed to start worker for ${acc.name}:`, err.message)
                );
                await TelegramService._sleep(2000);
            }
            console.log(`[TelegramService] Initialized ${accounts.length} workers`);
        } catch (err) {
            console.error('[TelegramService.initAllWorkers]', err.message);
        }
    },

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); },
};

module.exports = TelegramService;
