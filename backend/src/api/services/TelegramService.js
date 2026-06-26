'use strict';
/**
 * TelegramService — إدارة الـ Workers لمراقبة حسابات تيليجرام
 *
 * نظراً لعدم وجود مكتبة Telegram MTProto في المشروع الحالي،
 * يعتمد هذا النظام على نمط polling قابل للتوسع مع واجهة webhook.
 * يمكن ربطه بـ Telegram Bot API أو MTProto لاحقاً.
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');
const { v4: uuidv4 } = require('uuid');
const SocketBridge = require('../../core/SocketBridge');

// ── Regex لاكتشاف روابط واتساب ──────────────────────────────────────────────
const WA_LINK_PATTERN = /https?:\/\/(?:chat\.whatsapp\.com|wa\.me|api\.whatsapp\.com\/send)[^\s\])"'>]*/gi;

// ── خريطة الـ Workers النشطة ──────────────────────────────────────────────────
const activeWorkers = new Map(); // accountId → { intervalId, account, status }

const TelegramService = {

    // ── تشغيل worker لحساب واحد ─────────────────────────────────────────
    startWorker(account) {
        const id = account.id;

        if (activeWorkers.has(id)) {
            console.log(`[TelegramService] Worker ${id} already running`);
            return;
        }

        console.log(`[TelegramService] Starting worker for account: ${account.name}`);

        const workerState = {
            account,
            status: 'running',
            startedAt: new Date(),
            linksFound: 0,
            lastCheck: null,
            error: null,
        };

        // تحديث الحالة في قاعدة البيانات
        query(
            `UPDATE telegram_accounts SET status='connected', last_activity_at=NOW() WHERE id=$1`,
            [id]
        ).catch(() => {});

        // إرسال إشعار Socket.IO
        SocketBridge.emit('telegram:worker_started', {
            accountId: id,
            accountName: account.name,
        });

        // محاكاة polling كل 30 ثانية
        // في الإنتاج: استبدل هذا بـ Telegram MTProto client أو Bot API updates
        const intervalId = setInterval(async () => {
            try {
                workerState.lastCheck = new Date();
                await TelegramService._pollAccount(account, workerState);
            } catch (err) {
                workerState.error = err.message;
                console.error(`[TelegramService] Worker ${id} error:`, err.message);
            }
        }, 30_000);

        workerState.intervalId = intervalId;
        activeWorkers.set(id, workerState);
    },

    // ── إيقاف worker ─────────────────────────────────────────────────────
    stopWorker(accountId) {
        const worker = activeWorkers.get(accountId);
        if (!worker) return;

        clearInterval(worker.intervalId);
        activeWorkers.delete(accountId);

        query(
            `UPDATE telegram_accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`,
            [accountId]
        ).catch(() => {});

        SocketBridge.emit('telegram:worker_stopped', { accountId });
        console.log(`[TelegramService] Worker stopped: ${accountId}`);
    },

    // ── إيقاف جميع الـ workers ───────────────────────────────────────────
    stopAll() {
        for (const [id] of activeWorkers) {
            this.stopWorker(id);
        }
    },

    // ── حالة جميع الـ workers ────────────────────────────────────────────
    getAllWorkersStatus() {
        const result = [];
        for (const [id, state] of activeWorkers) {
            result.push({
                accountId: id,
                accountName: state.account.name,
                status: state.status,
                startedAt: state.startedAt,
                linksFound: state.linksFound,
                lastCheck: state.lastCheck,
                error: state.error,
            });
        }
        return result;
    },

    // ── استقبال رسالة من Telegram (webhook أو bot update) ────────────────
    async processIncomingMessage(accountId, accountName, channelOrGroup, message) {
        try {
            const links = message.match(WA_LINK_PATTERN) || [];
            for (const link of links) {
                const cleanLink = link.trim().replace(/[.,;:!?'")\]}]+$/, '');
                await TelegramService.saveLink({
                    whatsapp_link: cleanLink,
                    source_account_id: accountId,
                    source_account_name: accountName,
                    source_group: channelOrGroup,
                });
            }
        } catch (err) {
            console.error('[TelegramService.processIncomingMessage]', err.message);
        }
    },

    // ── حفظ رابط مع منع التكرار ─────────────────────────────────────────
    async saveLink({ whatsapp_link, source_account_id, source_account_name, source_group }) {
        try {
            // التحقق من وجود الرابط مسبقاً
            const existing = await queryOne(
                `SELECT id, duplicate_count FROM whatsapp_links WHERE whatsapp_link = $1`,
                [whatsapp_link]
            );

            if (existing) {
                // تحديث السجل الموجود
                await query(
                    `UPDATE whatsapp_links SET
                     duplicate_count = duplicate_count + 1,
                     last_seen = NOW(),
                     source_account_id = $2,
                     source_account_name = $3,
                     source_group = $4,
                     updated_at = NOW()
                     WHERE id = $1`,
                    [existing.id, source_account_id, source_account_name, source_group]
                );

                SocketBridge.emit('telegram:link_duplicate', {
                    linkId: existing.id,
                    whatsapp_link,
                    duplicate_count: existing.duplicate_count + 1,
                });

                return { isDuplicate: true, id: existing.id };
            }

            // إدراج رابط جديد
            const id = uuidv4();
            await query(
                `INSERT INTO whatsapp_links
                 (id, whatsapp_link, source_account_id, source_account_name, source_group,
                  discovered_at, last_seen, duplicate_count, status, joined, copied, deleted)
                 VALUES ($1,$2,$3,$4,$5,NOW(),NOW(),0,'new',false,false,false)`,
                [id, whatsapp_link, source_account_id, source_account_name, source_group]
            );

            const link = await queryOne(`SELECT * FROM whatsapp_links WHERE id = $1`, [id]);

            // إشعار فوري عبر Socket.IO
            SocketBridge.emit('telegram:new_link', link);

            // تحديث عداد الحساب
            if (source_account_id) {
                await query(
                    `UPDATE telegram_accounts SET links_collected = links_collected + 1, last_activity_at=NOW() WHERE id=$1`,
                    [source_account_id]
                ).catch(() => {});
            }

            return { isDuplicate: false, id };
        } catch (err) {
            console.error('[TelegramService.saveLink]', err.message);
            throw err;
        }
    },

    // ── polling داخلي (يُستبدل بـ MTProto في الإنتاج) ────────────────────
    async _pollAccount(account, workerState) {
        // هنا يتم استدعاء Telegram API لجلب الرسائل الجديدة
        // مثال: Bot API getUpdates أو Telegram MTProto getMessage
        // حالياً: تحديث last_activity فقط
        await query(
            `UPDATE telegram_accounts SET last_activity_at=NOW() WHERE id=$1`,
            [account.id]
        ).catch(() => {});
    },

    // ── تشغيل جميع الحسابات المتصلة عند بدء الخادم ──────────────────────
    async initAllWorkers() {
        try {
            const accounts = await queryAll(
                `SELECT * FROM telegram_accounts WHERE session_string IS NOT NULL AND status != 'disabled'`
            );
            for (const acc of accounts) {
                this.startWorker(acc);
                await new Promise(r => setTimeout(r, 500)); // تأخير بسيط بين الحسابات
            }
            console.log(`[TelegramService] Initialized ${accounts.length} workers`);
        } catch (err) {
            console.error('[TelegramService.initAllWorkers]', err.message);
        }
    },
};

module.exports = TelegramService;
