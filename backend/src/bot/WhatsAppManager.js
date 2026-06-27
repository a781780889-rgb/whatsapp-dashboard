'use strict';
/**
 * WhatsAppManager — Baileys WhatsApp Session Manager
 * [FIX-SESSION] استبدال useMultiFileAuthState (/tmp) بـ PostgreSQLAuthState
 * لأن /tmp يُمسح عند كل Railway deploy مما يُفقد الجلسة ويستوجب QR جديد.
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
    // ✅ FIX: كانت GroupSyncService تستخدم `WhatsAppManager.sessions.keys()` مباشرة
    //         لكن `sessions` متغيّر داخلي (closure) وليس خاصية على الكائن المُصدَّر،
    //         فكانت تفشل بصمت (Cannot read properties of undefined) في كل تكرار.
    getConnectedAccountIds() { return [...sessions.keys()]; }
    isOnline(accountId) { return sessions.has(accountId); }

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
                // نؤجل 3 ثوانٍ لنضمن استقرار الجلسة قبل استدعاء groupFetchAllParticipating
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

                // لا تعيد الاتصال لو تم تسجيل الخروج أو حُظر الحساب أو تعارض جلسة
                const noReconnectCodes = new Set([
                    DisconnectReason.loggedOut,
                    DisconnectReason.badSession,
                    DisconnectReason.forbidden,      // محظور
                ]);
                const shouldReconnect = !noReconnectCodes.has(statusCode);

                await SystemDB.run(
                    `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
                ).catch(() => {});
                emit('account_status', { accountId, status: 'disconnected' });

                if (shouldReconnect) {
                    // Exponential backoff: 5s, 10s, 20s, 40s, 60s (max)
                    const attempt = (reconnectAt.get(accountId) || 0) + 1;
                    reconnectAt.set(accountId, attempt);
                    const delay = Math.min(5000 * Math.pow(2, attempt - 1), 60000);
                    console.log(`[WAManager] Account ${accountId} disconnected — reconnecting in ${delay / 1000}s... (attempt ${attempt})`);
                    setTimeout(() => this._startSession(accountId), delay);
                } else {
                    reconnectAt.delete(accountId);
                    console.log(`[WAManager] Account ${accountId} logged out (statusCode=${statusCode}). Not reconnecting.`);
                    qrData.delete(accountId);
                    // حذف الجلسة من Redis و PostgreSQL عند logout
                    try { const SP = require('../core/SessionPersistence'); await SP.delete(accountId); } catch {}
                    await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});
                }
            }
        });

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const msg of messages) {
                if (!msg.message) continue;
                emit('new_message', { accountId, message: msg });
            }
        });

        // ── [GROUPS-LIVE] أحداث المجموعات الحيّة ────────────────────────────────
        // تُمكِّن صفحة "المجموعات" من التحديث تلقائياً (دون إعادة تحميل) عند:
        //  - انضمام الحساب لمجموعة جديدة                 → groups.upsert
        //  - تغيّر بيانات مجموعة (الاسم/الوصف/الإعدادات)   → groups.update
        //  - تغيّر الأعضاء، أو مغادرة/إزالة الحساب نفسه     → group-participants.update
        // التنفيذ الفعلي (قراءة/كتابة DB + بث Socket.IO) موجود في GroupRealtimeSync،
        // ويُستدعى بـ require متأخر لتجنّب أي تبعية دائرية مع GroupController.
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

    async connectAccount(accountId) {
        await this.initSession(accountId);
        return { success: true, message: 'Connection initiated' };
    }


    async startFreshQRSession(accountId) {
        // 1. أغلق الجلسة القديمة إن وجدت
        const sock = sessions.get(accountId);
        if (sock) {
            try { sock.end(); } catch {}
            sessions.delete(accountId);
        }
        connecting.delete(accountId);
        qrData.delete(accountId);

        // 2. احذف بيانات Auth من PostgreSQL لإجبار Baileys على توليد QR جديد
        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});

        // 3. ابدأ جلسة جديدة (بدون auth → Baileys سيولّد QR تلقائياً)
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
        await SystemDB.run(
            `UPDATE accounts SET status='disconnected', updated_at=NOW() WHERE id=$1`, [accountId]
        ).catch(() => {});
        emit('account_status', { accountId, status: 'disconnected' });
        return { success: true };
    }

    async resetSession(accountId) {
        await this.disconnectAccount(accountId);
        // [FIX-SESSION] حذف من PostgreSQL بدل /tmp
        await deletePostgreSQLAuthState(accountId, SystemDB).catch(() => {});
        qrData.delete(accountId);
        return { success: true, message: 'Session reset' };
    }

    async fullDeleteAccount(accountId) {
        await this.resetSession(accountId);
    }

    async sendMessage(accountId, jid, content) {
        const sock = sessions.get(accountId);
        if (!sock) throw new Error('Account not connected');
        return await sock.sendMessage(jid, content);
    }

    async sendTextMessage(accountId, phone, text) {
        const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
        return await this.sendMessage(accountId, jid, { text });
    }

    async sendGroupMessage(accountId, groupId, content) {
        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        return await this.sendMessage(accountId, jid, content);
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
    // كانت هذه الدالة تُعيد مصفوفة participants الخام من Baileys مباشرة، بينما
    // BroadcastController.directPublish يتوقع كائناً يحوي target_jids/admins/all.
    // هذا التعارض كان يجعل خيار "إرسال للأعضاء (خاص)" يفشل بصمت أو يرمي خطأ
    // (membersInfo.target_jids غير معرّف) دون أي رسالة واضحة في سجل الإرسال.
    async getGroupMembers(accountId, groupId) {
        const sock = sessions.get(accountId);
        if (!sock) {
            throw new Error('الحساب غير متصل بواتساب — لا يمكن قراءة أعضاء المجموعة');
        }

        const jid = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const metadata = await sock.groupMetadata(jid);
        const participants = metadata?.participants || [];

        // تطبيع JID لإزالة لاحقة الجهاز (":12@") عند وجودها
        const normalize = (j) => (j ? j.replace(/:\d+@/, '@') : null);

        // جمع كل الهويات الممكنة للحساب الحالي (PN/LID) — Baileys v7 يستخدم
        // @lid كهوية أساسية لكثير من المشاركين، فمطابقة PN فقط تفوّت الذات.
        const selfIds = new Set();
        for (const c of [sock.user?.id, sock.user?.lid, sock.authState?.creds?.me?.id, sock.authState?.creds?.me?.lid]) {
            const n = normalize(c);
            if (n) selfIds.add(n);
        }

        const all = [];
        const admins = [];
        const targetJids = []; // أعضاء عاديون فقط (بدون مشرفين، بدون الحساب نفسه)

        for (const p of participants) {
            const pJid = normalize(p.id);
            if (!pJid) continue;

            const candidates = [p.id, p.lid, p.phoneNumber, p.jid].map(normalize).filter(Boolean);
            const isSelf = candidates.some(c => selfIds.has(c));
            if (isSelf) continue; // لا نرسل رسالة للحساب نفسه

            const isAdmin = p.admin === 'admin' || p.admin === 'superadmin';
            const entry = { jid: pJid, phone: pJid.split('@')[0], is_admin: isAdmin };

            all.push(entry);
            if (isAdmin) admins.push(pJid);
            else targetJids.push(pJid);
        }

        return {
            all,
            admins,            // مصفوفة JIDs للمشرفين (Admins/Creators)
            target_jids: targetJids, // مصفوفة JIDs للأعضاء العاديين فقط
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
