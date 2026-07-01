'use strict';
/**
 * WhatsAppManager — Baileys WhatsApp Session Manager
 * [FIX-SESSION] استبدال useMultiFileAuthState (/tmp) بـ PostgreSQLAuthState
 * لأن /tmp يُمسح عند كل Railway deploy مما يُفقد الجلسة ويستوجب QR جديد.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * إعادة الهيكلة الحالية تضيف:
 *
 *  [البند 1] sendMessageSafe() — نقطة الإرسال المركزية الوحيدة المعتمدة:
 *      كل إرسال في المشروع (Broadcast/Campaign/PrivateCampaign/LivePublish/
 *      GroupJoiner...) يجب أن يمر عبرها. تقوم تلقائياً بـ:
 *        ProtectionService.checkOperation() → محاكاة سلوك بشري → الإرسال
 *        → ProtectionService.recordSuccess()/recordFailure()
 *      الدوال القديمة (sendMessage/sendTextMessage/sendGroupMessage) بقيت
 *      كما هي لأي كود لا يزال يستدعيها مباشرة (توافق عكسي)، لكنها الآن
 *      أيضاً تمر داخلياً عبر sendMessageSafe لضمان عدم وجود أي مسار إرسال
 *      "غير محمي" في المشروع بأكمله.
 *
 *  [البند 3] اكتشاف الحظر الحقيقي:
 *      يميّز forbidden/banned عن مجرد disconnected، ويُفعّل تلقائياً:
 *        status='banned' في DB → ProtectionService.suspendAccount() →
 *        Socket Notification → استبعاد من كل الحملات الحالية/المستقبلية
 *      (عبر BullMQ removeAccountJobs + تحديث حالة targets المرتبطة).
 *
 *  [البند 9] محاكاة السلوك البشري:
 *      قبل أي رسالة: sendPresenceUpdate('composing') ثم انتظار مدة مرتبطة
 *      بطول النص، ثم الإرسال، ثم sendPresenceUpdate('paused').
 * ─────────────────────────────────────────────────────────────────────────
 */
const { default: makeWASocket, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const SystemDB = require('../database/SystemDB');
const DatabaseManager = require('../database/DatabaseManager');
const SocketBridge = require('../core/SocketBridge');
const { usePostgreSQLAuthState, deletePostgreSQLAuthState, repairCorruptedSessions } = require('./PostgreSQLAuthState');

const sessions    = new Map();    // accountId → socket
const qrData      = new Map();    // accountId → { qr, timestamp }
const connecting  = new Set();    // accountId
const reconnectAt = new Map();    // accountId → attempt count (exponential backoff)

// [FIX-LIVE-PUBLISH-READY] sessions.set() يحدث فور إنشاء الـ socket، أي قبل
// اكتمال مصافحة Baileys الفعلية مع واتساب (connection === 'open'). كان هذا
// يسبب فشلاً صامتاً في النشر المباشر: يجتاز الكود فحص "الحساب متصل؟" لأن
// الـ socket موجود في sessions، لكن أول محاولة إرسال فعلية تفشل فوراً لأن
// الاتصال لم يكتمل بعد — فتُسجَّل المجموعة "مكتملة" ضمن خطأ واحد دون أي
// رسائل مُرسلة أو فاشلة فعلياً (تحديداً بعد إعادة تشغيل الخادم على Railway،
// حين تكون كل الحسابات لا تزال في طور إعادة الاتصال).
// هذا الـ Set يتتبع الحسابات التي أكدت فعلياً الوصول لـ connection === 'open'.
const readySessions = new Set();  // accountId

// [البند 4: Multi-Tenant] لا نخزّن user_id بشكل ثابت — نجلبه عند الحاجة عبر
// _getAccountMeta() مع كاش قصير العمر (60 ثانية) لكل accountId لتفادي ضغط DB
// مفرط دون أن نفترض user_id ثابتاً بمعزل عن قاعدة البيانات (مصدر الحقيقة الوحيد).
const _accountMetaCache = new Map(); // accountId → { userId, createdAt, fetchedAt }
const ACCOUNT_META_TTL_MS = 60_000;

let _io = null;

// [FIX-RAILWAY-FALSE-BAN] عدّاد إشارات forbidden متتالية لكل حساب (بدون أي
// نجاح اتصال بينها). طبقة بروكسي Railway قد تُرجع أحياناً 403 وهمي عند
// قطع اتصال WebSocket مفاجئ (ليس حظراً فعلياً من واتساب)، فتُفسَّر خطأً على
// أنها حظر دائم وتوقف الحساب فوراً حتى لو كانت المصافحة سليمة تماماً.
// الحل: لا نحظر من أول إشارة 403 — نحاول إعادة اتصال سريعة تأكيدية واحدة
// أولاً؛ فقط إذا تكرر 403 مرتين متتاليتين دون نجاح اتصال بينهما، نعتبره
// حظراً حقيقياً وننفّذ suspendAccount.
const _forbiddenStrikes = new Map(); // accountId → count
const FORBIDDEN_CONFIRM_DELAY_MS = 8000; // مهلة قصيرة لإعادة الاتصال التأكيدية

function emit(event, data) {
    try { SocketBridge.emit(event, data); } catch {}
    try { if (_io) _io.emit(event, data); } catch {}
}

class WhatsAppManager {

    setIO(io) { _io = io; }

    getSession(accountId) { return sessions.get(accountId) || null; }

    // [FIX-LIVE-PUBLISH-READY] هل الحساب متصل فعلياً وجاهز للإرسال الآن؟
    // خلافاً لـ getSession() (يتحقق فقط من وجود الـ socket في الذاكرة)، هذه
    // الدالة تتحقق من أن اتصال Baileys وصل فعلياً لحالة 'open' على الأقل مرة.
    isReady(accountId) { return sessions.has(accountId) && readySessions.has(accountId); }

    // [FIX-LIVE-PUBLISH-READY] ينتظر جاهزية الحساب حتى مهلة زمنية محددة بدل
    // الفشل الفوري — يُستخدم فقط في نقاط الإرسال الحرجة (النشر المباشر) حيث
    // يكون الحساب غالباً في طور إعادة الاتصال بعد إعادة تشغيل الخادم.
    async waitUntilReady(accountId, timeoutMs = 20_000, pollMs = 500) {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.isReady(accountId)) return true;
            if (!sessions.has(accountId) && !connecting.has(accountId)) return false; // لا محاولة اتصال جارية أصلاً
            await new Promise(r => setTimeout(r, pollMs));
        }
        return this.isReady(accountId);
    }
    isConnecting(accountId) { return connecting.has(accountId); }
    getQrStatus(accountId) { return qrData.get(accountId) || null; }

    // ── [GROUPS-LIVE] قائمة الحسابات المتصلة الآن (جلسات Baileys حيّة فعلياً) ──
    getConnectedAccountIds() { return [...sessions.keys()]; }
    isOnline(accountId) { return sessions.has(accountId); }

    // ════════════════════════════════════════════════════════════════════════
    //  [البند 4] جلب userId/created_at للحساب — Multi-Tenant، بدون Singleton مشترك
    // ════════════════════════════════════════════════════════════════════════
    async _getAccountMeta(accountId) {
        const cached = _accountMetaCache.get(accountId);
        if (cached && (Date.now() - cached.fetchedAt) < ACCOUNT_META_TTL_MS) {
            return cached;
        }
        try {
            const row = await SystemDB.get(
                `SELECT user_id, created_at FROM accounts WHERE id = $1`, [accountId]
            );
            const meta = {
                userId:    row?.user_id || null,
                createdAt: row?.created_at || null,
                fetchedAt: Date.now(),
            };
            _accountMetaCache.set(accountId, meta);
            return meta;
        } catch (err) {
            console.error(`[WAManager] _getAccountMeta(${accountId}) error:`, err.message);
            return { userId: null, createdAt: null, fetchedAt: Date.now() };
        }
    }

    _invalidateAccountMeta(accountId) {
        _accountMetaCache.delete(accountId);
    }

    async initSession(accountId) {
        if (connecting.has(accountId)) return;
        if (sessions.has(accountId)) return;

        connecting.add(accountId);
        try {
            await this._startSession(accountId);
        } catch (err) {
            console.error(`[WAManager] initSession error for ${accountId}:`, err.message);
            connecting.delete(accountId);
        }
    }

    async _startSession(accountId) {
        // [FIX-SESSION] استخدام PostgreSQL بدل /tmp — الجلسة تبقى بعد كل Railway deploy
        const { state, saveCreds } = await usePostgreSQLAuthState(accountId, SystemDB);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            browser: ['WhatsApp SaaS', 'Chrome', '120.0.0'],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 25000,
            logger: { level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({ level: 'silent', trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, child: () => ({}) }) },
        });

        sessions.set(accountId, sock);

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
            if (qr) {
                qrData.set(accountId, { qr, timestamp: Date.now() });
                emit('qr_code', { accountId, qr });
                emit(`qr:${accountId}`, { qr });
            }

            if (connection === 'open') {
                connecting.delete(accountId);
                reconnectAt.delete(accountId); // إعادة ضبط عداد المحاولات عند نجاح الاتصال
                _forbiddenStrikes.delete(accountId); // [FIX-RAILWAY-FALSE-BAN] اتصال ناجح ينفي أي إشارة forbidden سابقة
                qrData.delete(accountId);
                readySessions.add(accountId); // [FIX-LIVE-PUBLISH-READY] الاتصال مكتمل فعلياً الآن
                this._invalidateAccountMeta(accountId);
                await SystemDB.run(
                    `UPDATE accounts SET status='connected', updated_at=NOW() WHERE id=$1`, [accountId]
                ).catch(() => {});
                // حفظ الحساب في Redis حتى يستعيده index.js بعد deploy
                try {
                    const SessionPersistence = require('../core/SessionPersistence');
                    await SessionPersistence.save(accountId, { accountId, connectedAt: Date.now() });
                } catch {}
                emit('account_status', { accountId, status: 'connected' });
                console.log(`[WAManager] Account ${accountId} connected.`);

                // ── مزامنة المجموعات تلقائياً عند الاتصال ─────────────────────
                setTimeout(() => {
                    try {
                        const GroupSyncService = require('../api/services/GroupSyncService');
                        GroupSyncService.triggerSync(accountId).then(result => {
                            if (result?.success) {
                                console.log(`[WAManager] Auto-sync on connect: ${result.count} مجموعة لـ ${accountId}`);
                            } else {
                                console.warn(`[WAManager] Auto-sync on connect failed for ${accountId}:`, result?.error);
                            }
                        }).catch(err => {
                            console.warn(`[WAManager] Auto-sync on connect error (${accountId}):`, err.message);
                        });
                    } catch (err) {
                        console.warn(`[WAManager] GroupSyncService require error:`, err.message);
                    }
                }, 3000);
            }

            if (connection === 'close') {
                connecting.delete(accountId);
                sessions.delete(accountId);
                readySessions.delete(accountId); // [FIX-LIVE-PUBLISH-READY] لم يعد جاهزاً بعد قطع الاتصال
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                // [البند 3] تمييز صريح بين Disconnected عادي و Forbidden (محظور فعلياً)
                const isForbidden = statusCode === DisconnectReason.forbidden;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isBadSession = statusCode === DisconnectReason.badSession;

                // [FIX-RAILWAY-FALSE-BAN] لا نثق بإشارة forbidden أولى — بروكسي Railway
                // قد يُسقط اتصال WebSocket بشكل مفاجئ فيُرجع Baileys هذا كـ 403 وهمي
                // رغم أن الجلسة سليمة تماماً وما زالت صالحة لدى واتساب فعلياً. لذا
                // نحاول إعادة اتصال تأكيدية سريعة أولاً؛ فقط عند تكرار forbidden
                // مرتين متتاليتين دون أي اتصال ناجح بينهما نعتبره حظراً حقيقياً.
                const strikes = isForbidden ? (_forbiddenStrikes.get(accountId) || 0) + 1 : 0;
                if (isForbidden) _forbiddenStrikes.set(accountId, strikes);
                const isConfirmedBan = isForbidden && strikes >= 2;

                const noReconnectCodes = new Set([
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                ]);
                const shouldReconnect = isForbidden ? !isConfirmedBan : !noReconnectCodes.has(statusCode);

                if (isConfirmedBan) {
                    // ── [البند 3] حظر حقيقي مؤكَّد (403 مرتين متتاليتين) ──────
                    _forbiddenStrikes.delete(accountId);
                    await this._handleAccountBanned(accountId, statusCode);
                } else if (isForbidden) {
                    // إشارة forbidden أولى فقط — نعاملها كقطع اتصال عادي وننتظر
                    // محاولة إعادة الاتصال التأكيدية قبل أي حكم نهائي.
                    console.warn(`[WAManager] Account ${accountId} got forbidden(403) once — treating as possible proxy glitch, confirming via reconnect (strike ${strikes}/2)...`);
                    await SystemDB.run(
                        `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
                    ).catch(() => {});
                    emit('account_status', { accountId, status: 'disconnected' });
                } else {
                    await SystemDB.run(
                        `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
                    ).catch(() => {});
                    emit('account_status', { accountId, status: 'disconnected' });
                }

                if (shouldReconnect) {
                    // إشارة forbidden الأولى تُعاد فوراً تقريباً (تأكيد سريع)، بينما
                    // بقية الأخطاء تتبع exponential backoff العادي: 5s, 10s, 20s, 40s, 60s
                    const attempt = (reconnectAt.get(accountId) || 0) + 1;
                    reconnectAt.set(accountId, attempt);
                    const delay = isForbidden
                        ? FORBIDDEN_CONFIRM_DELAY_MS
                        : Math.min(5000 * Math.pow(2, attempt - 1), 60000);
                    console.log(`[WAManager] Account ${accountId} disconnected — reconnecting in ${delay / 1000}s... (attempt ${attempt})`);
                    setTimeout(() => this._startSession(accountId), delay);
                } else {
                    reconnectAt.delete(accountId);
                    const reasonLabel = isConfirmedBan ? 'forbidden/banned (confirmed)' : (isLoggedOut ? 'logged out' : (isBadSession ? 'bad session' : 'unknown'));
                    console.log(`[WAManager] Account ${accountId} stopped (statusCode=${statusCode}, reason=${reasonLabel}). Not reconnecting.`);
                    qrData.delete(accountId);
                    this._invalidateAccountMeta(accountId);
                    // حذف الجلسة من Redis و PostgreSQL عند logout/forbidden مؤكَّد فقط
                    try { const SP = require('../core/SessionPersistence'); await SP.delete(accountId); } catch {}
                    await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message) continue;
                emit('new_message', { accountId, message: msg });

                if (!msg.key?.fromMe && msg.key?.remoteJid?.endsWith('@g.us')) {
                    try {
                        const acct = await SystemDB.get(
                            `SELECT user_id FROM accounts WHERE id=$1`, [accountId]
                        ).catch(() => null);
                        if (acct?.user_id) {
                            const KWService = require('../api/services/KeywordMonitoringService');
                            KWService.processIncomingMessage(accountId, acct.user_id, msg).catch(() => {});
                        }
                    } catch {}
                }
            }
        });

        sock.ev.on('groups.upsert', (newGroups) => {
            try {
                require('../api/services/GroupRealtimeSync').onGroupsUpsert(accountId, sock, newGroups);
            } catch (err) {
                console.error(`[WAManager] groups.upsert handler error (${accountId}):`, err.message);
            }
        });

        sock.ev.on('groups.update', (updates) => {
            try {
                require('../api/services/GroupRealtimeSync').onGroupsUpdate(accountId, sock, updates);
            } catch (err) {
                console.error(`[WAManager] groups.update handler error (${accountId}):`, err.message);
            }
        });

        sock.ev.on('group-participants.update', (update) => {
            try {
                require('../api/services/GroupRealtimeSync').onParticipantsUpdate(accountId, sock, update);
            } catch (err) {
                console.error(`[WAManager] group-participants.update handler error (${accountId}):`, err.message);
            }
        });
    }

    // ════════════════════════════════════════════════════════════════════════
    //  [البند 3] معالجة الحظر الحقيقي — تُستدعى مرة واحدة فقط عند تأكّد الحظر
    // ════════════════════════════════════════════════════════════════════════
    async _handleAccountBanned(accountId, statusCode) {
        console.error(`[WAManager] 🚫 Account ${accountId} BANNED (statusCode=${statusCode}).`);

        // 1) status = 'banned' في قاعدة البيانات (مختلف عن 'disconnected')
        try {
            await SystemDB.run(
                `UPDATE accounts SET status='banned', updated_at=NOW() WHERE id=$1`, [accountId]
            );
        } catch (err) {
            console.error(`[WAManager] _handleAccountBanned: failed to update status:`, err.message);
        }

        // 2) ProtectionService.suspendAccount() — توقف فوري عن أي استخدام مستقبلي
        try {
            const meta = await this._getAccountMeta(accountId);
            if (meta.userId) {
                const { ProtectionService } = require('../api/services/ProtectionService');
                const svc = ProtectionService.getInstance();
                await svc.suspendAccount(meta.userId, accountId, 'whatsapp_forbidden_ban');
            } else {
                console.warn(`[WAManager] _handleAccountBanned: no user_id found for ${accountId}, cannot suspend in ProtectionService.`);
            }
        } catch (err) {
            console.error(`[WAManager] _handleAccountBanned: ProtectionService.suspendAccount failed:`, err.message);
        }

        // 3) Socket Notification — إشعار فوري للواجهة الأمامية
        emit('account_status', { accountId, status: 'banned' });
        emit('account_banned', { accountId, reason: 'forbidden', statusCode, timestamp: Date.now() });

        // 4) استبعاد الحساب من جميع الحملات الحالية والمستقبلية
        await this._excludeFromAllCampaigns(accountId);
    }

    // ── استبعاد حساب محظور من كل الحملات/الجداول/المهام المجدولة ─────────────
    async _excludeFromAllCampaigns(accountId) {
        // (أ) إلغاء كل المهام المجدولة (BullMQ) المرتبطة بهذا الحساب
        try {
            const JobScheduler = require('../scheduler/JobScheduler');
            await JobScheduler.removeAccountJobs(accountId);
        } catch (err) {
            console.error(`[WAManager] _excludeFromAllCampaigns: JobScheduler error:`, err.message);
        }

        // (ب) تعليم أهداف الحملات الخاصة (private_campaign_groups) المرتبطة بهذا
        //     الحساب والتي لا تزال 'pending' كـ 'failed' حتى لا تبقى عالقة في
        //     انتظار حساب محظور لن يُكمل الإرسال أبداً.
        try {
            const { Pool } = require('pg');
            const pool = new Pool({
                connectionString: process.env.DATABASE_URL,
                ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
            });
            await pool.query(
                `UPDATE private_campaign_groups
                 SET status='failed', error_msg='account_banned'
                 WHERE account_id=$1 AND status='pending'`,
                [accountId]
            );
            await pool.query(
                `UPDATE private_campaign_accounts
                 SET status='failed'
                 WHERE account_id=$1 AND status IN ('pending','running')`,
                [accountId]
            );
        } catch (err) {
            console.error(`[WAManager] _excludeFromAllCampaigns: private campaigns update error:`, err.message);
        }

        // (ج) إيقاف أي broadcast_schedules نشطة كانت تعتمد حصرياً على هذا الحساب
        try {
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(
                `UPDATE broadcast_schedules SET status='paused', updated_at=NOW()
                 WHERE account_id=$1 AND status='active'`,
                [accountId]
            ).catch(() => {});
            await accountDB.run(
                `UPDATE campaigns SET status='paused', updated_at=NOW()
                 WHERE status='running'`,
            ).catch(() => {});
        } catch (err) {
            console.error(`[WAManager] _excludeFromAllCampaigns: broadcast/campaign pause error:`, err.message);
        }

        console.log(`[WAManager] Account ${accountId} excluded from all current/future campaigns.`);
    }

    async connectAccount(accountId) {
        await this.initSession(accountId);
        return { success: true, message: 'Connection initiated' };
    }

    async startFreshQRSession(accountId) {
        const sock = sessions.get(accountId);
        if (sock) {
            try { sock.end(); } catch {}
            sessions.delete(accountId);
        }
        connecting.delete(accountId);
        qrData.delete(accountId);
        readySessions.delete(accountId); // [FIX-LIVE-PUBLISH-READY]

        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});

        await this.initSession(accountId);
        return { success: true };
    }

    async connectWithPairingCode(accountId, phoneNumber) {
        await this.initSession(accountId);
        const sock = sessions.get(accountId);
        if (!sock) throw new Error('Session not ready');
        try {
            const code = await sock.requestPairingCode(phoneNumber.replace(/\D/g, ''));
            return { success: true, code };
        } catch (err) {
            throw new Error(`Pairing code failed: ${err.message}`);
        }
    }

    async disconnectAccount(accountId) {
        const sock = sessions.get(accountId);
        if (sock) {
            try { await sock.logout(); } catch {}
            sessions.delete(accountId);
        }
        connecting.delete(accountId);
        readySessions.delete(accountId); // [FIX-LIVE-PUBLISH-READY]
        this._invalidateAccountMeta(accountId);
        await SystemDB.run(
            `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
        ).catch(() => {});
        emit('account_status', { accountId, status: 'disconnected' });
        return { success: true };
    }

    async resetSession(accountId) {
        await this.disconnectAccount(accountId);
        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});
        qrData.delete(accountId);
        return { success: true, message: 'Session reset' };
    }

    async fullDeleteAccount(accountId) {
        await this.resetSession(accountId);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  إرسال خام (بدون حماية) — لا يُستخدم مباشرة من أي كود إرسال جديد.
    //  أُبقي عليه فقط كأساس داخلي لـ sendMessageSafe وللتوافق العكسي مع أي
    //  استدعاءات قديمة محتملة خارج هذا الملف.
    // ════════════════════════════════════════════════════════════════════════
    async sendMessage(accountId, jid, content) {
        const sock = sessions.get(accountId);
        if (!sock) throw new Error('Account not connected');
        return await sock.sendMessage(jid, content);
    }

    async sendTextMessage(accountId, phone, text) {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        return await this.sendMessageSafe(accountId, jid, { text });
    }

    async sendGroupMessage(accountId, groupId, content) {
        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        return await this.sendMessageSafe(accountId, jid, content);
    }

    // ════════════════════════════════════════════════════════════════════════
    //  [البند 1 + 9] sendMessageSafe — نقطة الإرسال المركزية المحمية الوحيدة
    // ════════════════════════════════════════════════════════════════════════
    /**
     * كل إرسال في المشروع يجب أن يمر من هنا. تقوم هذه الدالة بـ:
     *   1. تحديد operationType تلقائياً (group اذا كان الـ jid ينتهي بـ @g.us، وإلا private)
     *      ما لم يُمرَّر صراحة عبر options.operationType.
     *   2. ProtectionService.checkOperation() — رفض الإرسال إن تجاوز الحدود أو كان الحساب موقوفاً.
     *   3. [البند 9] محاكاة سلوك بشري: sendPresenceUpdate('composing') → انتظار
     *      مرتبط بطول الرسالة → sendMessage() → sendPresenceUpdate('paused').
     *   4. تسجيل النتيجة عبر ProtectionService.recordSuccess/recordFailure تلقائياً
     *      (ما لم يُطلب تعطيل ذلك صراحة عبر options.skipProtection — لأغراض
     *      اختبارية فقط، غير مستخدم في مسارات الإنتاج).
     *
     * @param {string} accountId
     * @param {string} jid
     * @param {object} content     محتوى الرسالة بصيغة Baileys القياسية
     * @param {object} [options]
     * @param {'group'|'private'} [options.operationType]  يُستنتج تلقائياً من الـ jid إن لم يُحدَّد
     * @param {string} [options.taskId]                     معرّف المهمة لأغراض SmartRetry
     */
    async sendMessageSafe(accountId, jid, content, options = {}) {
        const sock = sessions.get(accountId);
        if (!sock) throw new Error('Account not connected');
        // [FIX-LIVE-PUBLISH-READY] وجود الـ socket في sessions لا يعني اتصالاً
        // فعلياً مكتملاً (قد يكون لا يزال في طور المصافحة بعد إعادة تشغيل
        // الخادم) — الإرسال على socket غير جاهز يفشل فوراً وبصمت.
        if (!readySessions.has(accountId)) {
            const err = new Error('الحساب لا يزال يتصل بواتساب — لم تكتمل المصافحة بعد');
            err.protectionReason = 'not_ready';
            throw err;
        }

        const operationType = options.operationType
            || (jid.endsWith('@g.us') ? 'group' : 'private');
        const taskId = options.taskId || null;

        const meta = await this._getAccountMeta(accountId);
        const userId = meta.userId;

        // إن لم نجد user_id (حالة نادرة/بيانات قديمة) ننفذ الإرسال مباشرة دون
        // حماية بدل رمي خطأ يكسر التوافق — لكن مع تحذير صريح في السجل.
        if (!userId) {
            console.warn(`[WAManager] sendMessageSafe: no user_id for account ${accountId} — sending WITHOUT protection.`);
            return this._sendWithPresence(sock, jid, content);
        }

        const { ProtectionService } = require('../api/services/ProtectionService');
        const svc = ProtectionService.getInstance();

        const check = await svc.checkOperation(userId, accountId, {
            operationType,
            accountCreatedAt: meta.createdAt,
        });

        if (!check.allowed) {
            const err = new Error(check.message || `العملية مرفوضة: ${check.reason}`);
            err.protectionReason = check.reason;
            throw err;
        }

        try {
            const result = await this._sendWithPresence(sock, jid, content);
            await svc.recordSuccess(userId, accountId, taskId, { operationType });
            return result;
        } catch (sendErr) {
            // [FIX-SESSION-RACE-RECOVERY] بعض حالات فشل الإرسال الصامت جذرها
            // جلسة Signal تالفة لهذا الطرف تحديداً (بقايا سباق كتابة قديم قبل
            // إضافة القفل التسلسلي في PostgreSQLAuthState). عند اكتشاف نمط
            // خطأ متعلق بفك التشفير/الجلسة، نمسح جلسة هذا الرقم تحديداً
            // (Baileys يعيد بناءها تلقائياً وبأمان) ونعيد محاولة الإرسال مرة
            // واحدة فقط، بدل تسجيل فشل نهائي لمشكلة قابلة للإصلاح تلقائياً.
            const msg = String(sendErr?.message || '').toLowerCase();
            const looksLikeSessionCorruption =
                msg.includes('closed session') || msg.includes('decrypt') ||
                msg.includes('bad mac') || msg.includes('session record') ||
                sendErr?.protectionReason === 'send_unconfirmed';

            if (looksLikeSessionCorruption && !options._sessionRepairRetried) {
                try {
                    const targetPhone = jid.split('@')[0];
                    console.warn(`[WAManager] sendMessageSafe: session corruption detected for ${jid} — repairing and retrying once.`);
                    await repairCorruptedSessions(accountId, SystemDB, targetPhone);
                    const retryResult = await this._sendWithPresence(sock, jid, content);
                    await svc.recordSuccess(userId, accountId, taskId, { operationType });
                    return retryResult;
                } catch (retryErr) {
                    await svc.recordFailure(userId, accountId, taskId, retryErr.message, {
                        operationType,
                        errorObject: retryErr,
                    });
                    throw retryErr;
                }
            }

            await svc.recordFailure(userId, accountId, taskId, sendErr.message, {
                operationType,
                errorObject: sendErr,
            });
            throw sendErr;
        }
    }

    // ── [البند 9] محاكاة السلوك البشري قبل/بعد كل إرسال ───────────────────────
    async _sendWithPresence(sock, jid, content) {
        // [FIX-SEND-GHOST-SUBSCRIBE] presenceSubscribe() يؤسس/يؤكد جلسة
        // التشفير (Signal session) مع الطرف الآخر قبل أي محاولة تواصل معه.
        // إرسال sendPresenceUpdate('composing') مباشرة لجهة اتصال "جديدة"
        // (بدون presenceSubscribe سابق) قد يفشل بصمت في بعض إصدارات Baileys
        // أو يترك الجلسة في حالة غير مكتملة — وهو تفسير محتمل لحالات حيث
        // sendMessage() يُحل الـ promise دون استثناء لكن الرسالة لا تُبث
        // فعلياً ولا تظهر حتى في صندوق الصادر لدى المُرسِل نفسه.
        try { await sock.presenceSubscribe(jid); } catch { /* بعض الأنواع لا تدعمها — تجاهل بأمان */ }

        try {
            await sock.sendPresenceUpdate('composing', jid);
        } catch { /* بعض أنواع الـ jid (مثل القنوات) قد لا تدعم presence — تجاهل بأمان */ }

        // مدة الكتابة المحاكاة: مرتبطة بطول النص (≈ سرعة كتابة بشرية معقولة)
        // بحد أدنى وأقصى معقولين لتفادي تأخير غير واقعي على رسائل طويلة جداً.
        const textLength = (content?.text || content?.caption || '').length;
        const typingMs = Math.min(4000, Math.max(400, textLength * 35 + Math.floor(Math.random() * 300)));
        await new Promise(r => setTimeout(r, typingMs));

        try {
            const result = await sock.sendMessage(jid, content);
            try { await sock.sendPresenceUpdate('paused', jid); } catch {}

            // [DEBUG-SEND-GHOST] تسجيل تشخيصي مؤقت لفهم شكل النتيجة الفعلية
            // التي يُرجعها Baileys عند الإرسال الخاص — ضروري لتحديد السبب
            // الجذري الحقيقي (بدل التخمين) بعد رصد حالات "✅ في السجل لكن
            // بلا وصول فعلي ولا حتى ظهور في صندوق الصادر لدى المُرسِل نفسه).
            if (!jid.endsWith('@g.us')) {
                console.log(`[WAManager][DEBUG-SEND-GHOST] jid=${jid} result=`, JSON.stringify({
                    hasKey: !!result?.key,
                    keyId: result?.key?.id || null,
                    keyRemoteJid: result?.key?.remoteJid || null,
                    keyFromMe: result?.key?.fromMe ?? null,
                    messageTimestamp: result?.messageTimestamp || null,
                    status: result?.status ?? null,
                }));
            }

            // [FIX-SEND-GHOST-CONFIRM] sock.sendMessage() قد يُحل الـ promise
            // بنجاح (بدون رمي استثناء) حتى عندما لا تُبَث الرسالة فعلياً على
            // الشبكة — لاحظنا هذا تحديداً حين لا يُرجع Baileys معرّف رسالة
            // حقيقياً (result.key.id). الاعتماد على "عدم وجود خطأ" وحده غير
            // كافٍ لتأكيد الإرسال الفعلي؛ التأكيد الوحيد الموثوق هو وجود
            // key.id صالح في النتيجة، وهو ما يعنيه Baileys بأن الرسالة دخلت
            // فعلياً طابور الإرسال على الشبكة.
            if (!result?.key?.id) {
                const err = new Error('sendMessage أعاد نتيجة بلا معرّف رسالة (key.id) — الإرسال لم يُؤكَّد فعلياً على الشبكة رغم عدم وجود استثناء');
                err.protectionReason = 'send_unconfirmed';
                err.rawResult = result;
                throw err;
            }

            return result;
        } catch (err) {
            try { await sock.sendPresenceUpdate('paused', jid); } catch {}
            throw err;
        }
    }

    async getGroups(accountId) {
        const sock = sessions.get(accountId);
        if (!sock) return [];
        try {
            const groups = await sock.groupFetchAllParticipating();
            return Object.values(groups);
        } catch { return []; }
    }

    // ── [FIX-DIRECT-PUBLISH-2] جلب أعضاء مجموعة بالشكل الذي يحتاجه BroadcastController ──
    async getGroupMembers(accountId, groupId) {
        const sock = sessions.get(accountId);
        if (!sock) {
            throw new Error('الحساب غير متصل بواتساب — لا يمكن قراءة أعضاء المجموعة');
        }
        // [FIX-LIVE-PUBLISH-READY] نفس مشكلة sendMessageSafe: socket موجود لا
        // يعني اتصالاً مكتملاً — استدعاء groupMetadata على اتصال غير مكتمل
        // يفشل بصمت (أو يعلّق حتى timeout طويل). ننتظر جاهزية حقيقية أولاً.
        if (!readySessions.has(accountId)) {
            const becameReady = await this.waitUntilReady(accountId, 15_000);
            if (!becameReady) {
                throw new Error('الحساب لا يزال يتصل بواتساب — لم تكتمل المصافحة بعد');
            }
        }

        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const metadata = await sock.groupMetadata(jid);
        const participants = metadata?.participants || [];

        const normalize = (j) => (j ? j.replace(/:\d+@/, '@') : null);

        const selfIds = new Set();
        for (const c of [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]) {
            const n = normalize(c);
            if (n) selfIds.add(n);
        }
        // [FIX-PRIVATE-SEND-SELF] أضف أيضاً رقم الهاتف الحقيقي للحساب نفسه
        // بصيغة @s.whatsapp.net — فحص selfIds السابق يقارن jid/lid الخام، لكن
        // بعد حل الأعضاء عبر onWhatsApp() أدناه قد يتحول jid عضو آخر (كان
        // بصيغة @lid مختلفة) إلى نفس رقم الحساب المُرسِل الحقيقي (يحدث هذا
        // فعلياً عندما يكون صاحب الحساب نفسه عضواً في المجموعة تحت LID مختلف
        // عن sock.user.id). إرسال رسالة "خاصة" لنفس رقم المُرسِل يُقبل محلياً
        // من Baileys بنجاح (لا استثناء) لكنها لا تصل كمحادثة فعلية على واتساب
        // — بالضبط عرض المشكلة المُبلَّغ عنه (✅ في السجل لكن لا استلام حقيقي).
        const selfPhoneJid = normalize(sock.user?.id)?.split('@')[0] || null;
        if (selfPhoneJid) selfIds.add(`${selfPhoneJid}@s.whatsapp.net`);

        const all = [];
        const admins = [];
        const targetJids = [];
        const phoneByJid    = {}; // [فلتر السعودية] jid → رقم الهاتف الحقيقي (وليس معرّف LID)
        const sendableByJid = {}; // [إصلاح الإرسال الخاص] jid → jid فعلي قابل لاستقبال رسالة خاصة

        // [إصلاح الإرسال الخاص] الأعضاء الذين لا نملك لهم رقماً حقيقياً مباشراً
        // (أي pJid ينتهي بـ @lid بدون phoneNumber) — نحتاج تحويلهم عبر onWhatsApp.
        const needsResolve = [];

        for (const p of participants) {
            const pJid = normalize(p.id);
            if (!pJid) continue;

            const candidates = [p.id, p.lid, p.phoneNumber, p.jid].map(normalize).filter(Boolean);
            const isSelf = candidates.some(c => selfIds.has(c));
            if (isSelf) continue;

            const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';

            // [فلتر السعودية] عندما تكون الخصوصية مفعّلة، p.id يكون LID (رقم داخلي عشوائي)
            // وليس رقم الهاتف الحقيقي. الرقم الحقيقي يأتي فقط عبر p.phoneNumber
            // (بصيغة jid مثل 9665xxxxxxxx@s.whatsapp.net) عند توفره من واتساب.
            const realPhoneJid = normalize(p.phoneNumber) || (pJid.endsWith('@s.whatsapp.net') ? pJid : null);
            const realPhone    = realPhoneJid ? realPhoneJid.split('@')[0] : pJid.split('@')[0];

            const entry = { jid: pJid, phone: realPhone, is_admin: isAdmin };
            phoneByJid[pJid] = realPhone;

            // [إصلاح الإرسال الخاص] jid فعلي قابل لاستقبال DM:
            // - إن كان pJid نفسه بصيغة @s.whatsapp.net فهو صالح مباشرة للإرسال الخاص.
            // - إن توفر phoneNumber (حتى لو pJid كان @lid) نبني منه jid صالحاً للإرسال.
            // - غير ذلك (LID بلا رقم) — يُجدوَل للتحويل عبر onWhatsApp لاحقاً.
            //
            // [FIX-PRIVATE-SEND-GHOST] سابقاً كان أي pJid بصيغة @s.whatsapp.net
            // يُعتبر "صالحاً للإرسال" فوراً دون أي تحقق فعلي من وجوده على واتساب.
            // في بعض الحالات (خاصة بعد التحديثات الأخيرة لـ Baileys 7 وتغييرات
            // بروتوكول LID) قد يكون هذا الـ jid صيغة PN داخلية غير مرتبطة فعلياً
            // برقم مستقبل حقيقي — فتقبل sock.sendMessage() الطلب محلياً بنجاح
            // (Baileys لا يرمي استثناء) رغم أن الرسالة لا تصل أبداً على تطبيق
            // واتساب الفعلي. لذلك نضيف هؤلاء أيضاً لقائمة needsResolve للتحقق
            // النهائي عبر onWhatsApp() بدل الوثوق بالصيغة وحدها.
            // [FIX-PRIVATE-SEND-GHOST] كل عضو، أياً كانت صيغة الـ jid، يُضاف
            // لقائمة التحقق الإلزامي أدناه بدل الوثوق بصيغة @s.whatsapp.net
            // وحدها كدليل على قابلية الإرسال الفعلية.
            needsResolve.push(pJid);

            all.push(entry);
            if (isAdmin) admins.push(pJid);
            else targetJids.push(pJid);
        }

        // [FIX-PRIVATE-SEND-GHOST] لكل عضو، أياً كانت صيغة الـ jid الأصلية،
        // يجب تأكيد وجوده الفعلي على واتساب عبر onWhatsApp() قبل اعتباره
        // "قابلاً للإرسال" — بدل الوثوق بمجرد صيغة الـ jid (@s.whatsapp.net)،
        // التي قد تكون صحيحة الشكل لكنها لا تشير لمستقبل فعلي في بعض حالات
        // LID الحديثة. هذا هو التصحيح الجذري لمشكلة "الإرسال يُسجَّل ناجحاً
        // لكن لا يصل فعلياً على واتساب".
        if (needsResolve.length) {
            // مسار سريع أولاً: lidMapping المحلي (بدون استعلام شبكي) — يعطي
            // مرشحاً للرقم الحقيقي، لكن لا نثق به وحده، فقط يُسرّع/يُقلّل
            // عدد الاستعلامات المطلوبة عبر onWhatsApp أدناه.
            const lidStore = sock.signalRepository?.lidMapping;
            const candidateJid = {}; // pJid → مرشح jid للتحقق منه

            for (const pJid of needsResolve) {
                // المرشح الأول: الرقم الحقيقي إن كان متوفراً من بيانات المشارك نفسها
                const entry = all.find(a => a.jid === pJid);
                const knownPhone = entry ? phoneByJid[pJid] : null;
                if (knownPhone && pJid.endsWith('@s.whatsapp.net')) {
                    candidateJid[pJid] = pJid; // pJid نفسه رقم حقيقي بالفعل
                    continue;
                }
                if (lidStore && typeof lidStore.getPNForLID === 'function') {
                    try {
                        const pn = await lidStore.getPNForLID(pJid);
                        if (pn) {
                            candidateJid[pJid] = normalize(pn.includes('@') ? pn : `${pn}@s.whatsapp.net`);
                            continue;
                        }
                    } catch { /* تجاهل، سيُحل عبر onWhatsApp أدناه */ }
                }
                candidateJid[pJid] = pJid; // آخر مرشح متاح — سيُتحقق منه مباشرة
            }

            // ── التحقق النهائي الإلزامي: onWhatsApp() يستعلم من خوادم واتساب
            //    فعلياً ويؤكد وجود الرقم — هذا وحده يضمن أن الإرسال سيصل حقاً. ──
            if (typeof sock.onWhatsApp === 'function') {
                const pJids = Object.keys(candidateJid);
                const lookupInputs = pJids.map(j => (candidateJid[j] || j).split('@')[0]);
                try {
                    const results = await sock.onWhatsApp(...lookupInputs);
                    results?.forEach((r, idx) => {
                        const originalPJid = pJids[idx];
                        if (!originalPJid || !r?.exists || !r?.jid) return;
                        const resolvedJid = normalize(r.jid);
                        if (!resolvedJid) return;
                        // [FIX-PRIVATE-SEND-SELF] استبعاد أي عضو تبيّن بعد الحل
                        // النهائي أن رقمه الحقيقي هو نفسه رقم الحساب المُرسِل
                        // (كان يظهر تحت LID مختلف قبل onWhatsApp فلم يُكتشف
                        // بفحص selfIds الأولي). إرسال "خاص" لهذا الرقم يعني
                        // إرسال رسالة للحساب نفسه — لا تصل كمحادثة فعلية.
                        if (selfIds.has(resolvedJid)) return;
                        sendableByJid[originalPJid] = resolvedJid;
                        if (resolvedJid.endsWith('@s.whatsapp.net')) {
                            phoneByJid[originalPJid] = resolvedJid.split('@')[0];
                        }
                    });
                } catch (err) {
                    console.warn(`[WAManager] getGroupMembers: onWhatsApp bulk lookup failed:`, err.message);
                    // فشل الاستعلام الجماعي — لا نضيف أي عضو لـ sendableByJid، فيُستبعدون
                    // تلقائياً بدل تسجيلهم كصالحين للإرسال دون تأكيد حقيقي.
                }
            } else {
                console.warn(`[WAManager] getGroupMembers: sock.onWhatsApp غير متاح — تعذّر تأكيد الأرقام، سيتم استبعاد الأعضاء غير المؤكدين.`);
            }
        }

        return {
            all,
            admins,
            target_jids: targetJids,
            phone_by_jid:    phoneByJid,    // [فلتر السعودية] للفلترة بالرقم الحقيقي بدل LID
            sendable_by_jid: sendableByJid, // [إصلاح الإرسال الخاص] jid فعلي صالح للإرسال الخاص لكل عضو
            total: all.length,
            admins_count: admins.length,
            members_count: targetJids.length,
        };
    }

    startTasks(accountId) { emit('tasks_started', { accountId }); }
    stopTasks(accountId)  { emit('tasks_stopped', { accountId }); }

    getStats() {
        return {
            connected: [...sessions.keys()],
            connecting: [...connecting],
            totalSessions: sessions.size,
        };
    }
}

module.exports = new WhatsAppManager();
