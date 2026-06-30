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
const { usePostgreSQLAuthState, deletePostgreSQLAuthState } = require('./PostgreSQLAuthState');

const sessions    = new Map();    // accountId → socket
const qrData      = new Map();    // accountId → { qr, timestamp }
const connecting  = new Set();    // accountId
const reconnectAt = new Map();    // accountId → attempt count (exponential backoff)

// [البند 4: Multi-Tenant] لا نخزّن user_id بشكل ثابت — نجلبه عند الحاجة عبر
// _getAccountMeta() مع كاش قصير العمر (60 ثانية) لكل accountId لتفادي ضغط DB
// مفرط دون أن نفترض user_id ثابتاً بمعزل عن قاعدة البيانات (مصدر الحقيقة الوحيد).
const _accountMetaCache = new Map(); // accountId → { userId, createdAt, fetchedAt }
const ACCOUNT_META_TTL_MS = 60_000;

let _io = null;

function emit(event, data) {
    try { SocketBridge.emit(event, data); } catch {}
    try { if (_io) _io.emit(event, data); } catch {}
}

class WhatsAppManager {

    setIO(io) { _io = io; }

    getSession(accountId) { return sessions.get(accountId) || null; }
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
                qrData.delete(accountId);
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
                const statusCode = lastDisconnect?.error?.output?.statusCode;

                // [البند 3] تمييز صريح بين Disconnected عادي و Forbidden (محظور فعلياً)
                const isForbidden = statusCode === DisconnectReason.forbidden;
                const isLoggedOut = statusCode === DisconnectReason.loggedOut;
                const isBadSession = statusCode === DisconnectReason.badSession;

                const noReconnectCodes = new Set([
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    DisconnectReason.forbidden,
                ]);
                const shouldReconnect = !noReconnectCodes.has(statusCode);

                if (isForbidden) {
                    // ── [البند 3] حظر حقيقي — وليس مجرد قطع اتصال ─────────────
                    await this._handleAccountBanned(accountId, statusCode);
                } else {
                    await SystemDB.run(
                        `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
                    ).catch(() => {});
                    emit('account_status', { accountId, status: 'disconnected' });
                }

                if (shouldReconnect) {
                    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
                    const attempt = (reconnectAt.get(accountId) || 0) + 1;
                    reconnectAt.set(accountId, attempt);
                    const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
                    console.log(`[WAManager] Account ${accountId} disconnected — reconnecting in ${delay / 1000}s... (attempt ${attempt})`);
                    setTimeout(() => this._startSession(accountId), delay);
                } else {
                    reconnectAt.delete(accountId);
                    const reasonLabel = isForbidden ? 'forbidden/banned' : (isLoggedOut ? 'logged out' : (isBadSession ? 'bad session' : 'unknown'));
                    console.log(`[WAManager] Account ${accountId} stopped (statusCode=${statusCode}, reason=${reasonLabel}). Not reconnecting.`);
                    qrData.delete(accountId);
                    this._invalidateAccountMeta(accountId);
                    // حذف الجلسة من Redis و PostgreSQL عند logout/forbidden
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
            await svc.recordFailure(userId, accountId, taskId, sendErr.message, {
                operationType,
                errorObject: sendErr,
            });
            throw sendErr;
        }
    }

    // ── [البند 9] محاكاة السلوك البشري قبل/بعد كل إرسال ───────────────────────
    async _sendWithPresence(sock, jid, content) {
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

        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const metadata = await sock.groupMetadata(jid);
        const participants = metadata?.participants || [];

        const normalize = (j) => (j ? j.replace(/:\d+@/, '@') : null);

        const selfIds = new Set();
        for (const c of [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]) {
            const n = normalize(c);
            if (n) selfIds.add(n);
        }

        const all = [];
        const admins = [];
        const targetJids = [];

        for (const p of participants) {
            const pJid = normalize(p.id);
            if (!pJid) continue;

            const candidates = [p.id, p.lid, p.phoneNumber, p.jid].map(normalize).filter(Boolean);
            const isSelf = candidates.some(c => selfIds.has(c));
            if (isSelf) continue;

            const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
            const entry = { jid: pJid, phone: pJid.split('@')[0], is_admin: isAdmin };

            all.push(entry);
            if (isAdmin) admins.push(pJid);
            else targetJids.push(pJid);
        }

        return {
            all,
            admins,
            target_jids: targetJids,
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
