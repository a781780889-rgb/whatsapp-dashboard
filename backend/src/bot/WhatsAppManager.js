'use strict';
/**
 * WhatsAppManager — Baileys WhatsApp Session Manager
 */
const path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const SystemDB = require('../database/SystemDB');
const DatabaseManager = require('../database/DatabaseManager');
const SocketBridge = require('../core/SocketBridge');

const AUTH_DIR = path.resolve('/tmp/wa-auth');
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
        const authDir = path.join(AUTH_DIR, accountId);
        const fs = require('fs');
        if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
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

        // 2. احذف ملفات Auth القديمة لإجبار Baileys على توليد QR جديد
        const fs = require('fs');
        const authDir = path.join(AUTH_DIR, accountId);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }

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
        const fs = require('fs');
        const authDir = path.join(AUTH_DIR, accountId);
        if (fs.existsSync(authDir)) {
            fs.rmSync(authDir, { recursive: true, force: true });
        }
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

    async getGroupMembers(accountId, groupId) {
        const sock = sessions.get(accountId);
        if (!sock) return [];
        try {
            const metadata = await sock.groupMetadata(groupId);
            return metadata.participants || [];
        } catch { return []; }
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
