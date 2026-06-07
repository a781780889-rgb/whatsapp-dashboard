'use strict';
const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, initAuthCreds, makeCacheableSignalKeyStore, proto } = require('@whiskeysockets/baileys');
const pino   = require('pino');
const Boom   = require('@hapi/boom');
const path   = require('path');
const fs     = require('fs');
const SystemDB   = require('../database/SystemDB');
const DatabaseManager = require('../database/DatabaseManager');
const { getRedis } = require('../lib/redis');

const ANTI_BAN = {
    maxPerHour:  parseInt(process.env.MAX_MSG_PER_HOUR  || '200',  10),
    minDelay:    parseInt(process.env.MSG_MIN_DELAY_MS  || '2000', 10),
    maxDelay:    parseInt(process.env.MSG_MAX_DELAY_MS  || '8000', 10),
    warmupDays:  parseInt(process.env.WARMUP_DAYS       || '7',    10),
    warmupLimit: parseInt(process.env.WARMUP_LIMIT      || '30',   10),
};

// ─────────────────────────────────────────────────────────────
// الأكواد التي تعني "الجلسة فاسدة / انتهت" ويجب مسحها
// ─────────────────────────────────────────────────────────────
const BAD_SESSION_CODES = new Set([
    DisconnectReason.badSession,          // 500  ← السبب الرئيسي
    DisconnectReason.loggedOut,           // 401
    DisconnectReason.connectionReplaced,  // 440
]);

class WhatsAppManager {
    constructor() {
        this.sessions         = new Map(); // accountId → socket
        this.reconnectAttempts = new Map();
        this.initPromises     = new Map();
        this.io               = null;
        this.logger           = pino({ level: 'silent' });
    }

    setIO(io) { this.io = io; }

    // ── PostgreSQL Auth State ────────────────────────────────────────────────
    async _usePostgresAuthState(accountId) {
        const DB_KEY_CREDS = 'creds';

        let creds = await SystemDB.getSessionData(accountId, DB_KEY_CREDS);
        if (!creds) {
            creds = initAuthCreds();
        }

        const saveState = async () => {
            await SystemDB.saveSessionData(accountId, DB_KEY_CREDS, creds);
        };

        const keys = {
            async get(type, ids) {
                const result = {};
                await Promise.all(ids.map(async (id) => {
                    const dbKey = `keys:${type}:${id}`;
                    const data  = await SystemDB.getSessionData(accountId, dbKey);
                    if (data != null) {
                        let value = data;
                        if (type === 'app-state-sync-key' && data) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(data);
                        }
                        result[id] = value;
                    }
                }));
                return result;
            },
            async set(data) {
                await Promise.all(
                    Object.entries(data).flatMap(([type, typeData]) =>
                        Object.entries(typeData || {}).map(([id, value]) => {
                            const dbKey = `keys:${type}:${id}`;
                            if (value) return SystemDB.saveSessionData(accountId, dbKey, value);
                            else       return SystemDB.deleteSessionData(accountId, dbKey);
                        })
                    )
                );
            }
        };

        const state = {
            creds,
            keys: makeCacheableSignalKeyStore(keys, this.logger),
        };

        return { state, saveCreds: saveState };
    }

    // ── Human-like delay ─────────────────────────────────────────────────────
    _humanDelay() {
        const ms = ANTI_BAN.minDelay + Math.random() * (ANTI_BAN.maxDelay - ANTI_BAN.minDelay);
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ── Rate limiting ────────────────────────────────────────────────────────
    async _checkRateLimit(accountId) {
        try {
            const redis   = getRedis();
            const hourKey = `rate:${accountId}:${Math.floor(Date.now() / 3600000)}`;
            const account = await SystemDB.get(`SELECT warmup_phase, messages_sent_today FROM accounts WHERE id = $1`, [accountId]);
            const limit   = account?.warmup_phase ? ANTI_BAN.warmupLimit : ANTI_BAN.maxPerHour;
            const count   = await redis.incr(hourKey);
            if (count === 1) await redis.expire(hourKey, 3600);
            if (count > limit) {
                await SystemDB.updateAccountHealth(accountId, 'at_risk');
                throw new Error(`[Anti-Ban] Rate limit reached for account ${accountId}: ${count}/${limit}`);
            }
            await SystemDB.updateMessageStats(accountId);
            return true;
        } catch (err) {
            if (err.message.includes('Anti-Ban')) throw err;
            console.warn('[Anti-Ban] Rate limit check failed (Redis unavailable):', err.message);
            return true;
        }
    }

    // ── Send with Anti-Ban ───────────────────────────────────────────────────
    async sendMessageSafe(accountId, to, content) {
        await this._checkRateLimit(accountId);
        await this._humanDelay();
        const sock = this.getSession(accountId);
        if (!sock) throw new Error('WhatsApp session not connected.');
        return sock.sendMessage(to, content);
    }

    // ── مسح جلسة فاسدة وإعادة التهيئة لـ QR جديد ───────────────────────────
    async _clearBadSession(accountId, reason) {
        console.log(`[Account ${accountId}] Bad session (${reason}). Clearing PostgreSQL data…`);

        // مسح الجلسة من الذاكرة
        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId); // ← إعادة العداد إلى صفر

        // مسح بيانات الجلسة من PostgreSQL
        await SystemDB.deleteAllSessionData(accountId).catch(console.error);

        // تحديث حالة الحساب
        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [accountId]
        ).catch(console.error);

        if (this.io) {
            this.io.emit('account_status', { accountId, status: 'disconnected', reason: 'bad_session' });
            this.io.to(`account_${accountId}`).emit('session_cleared', { accountId });
            this.io.emit('notification', {
                type: 'warning',
                title: 'جلسة منتهية',
                message: `جلسة الحساب انتهت. سيظهر رمز QR جديد تلقائياً.`,
                accountId
            });
        }

        // إعادة التهيئة بعد ثانيتين → سيولّد QR جديد لأن الـ creds أُزيلت
        setTimeout(() => this.initSession(accountId), 2000);
    }

    // ── Init Session ─────────────────────────────────────────────────────────
    async initSession(accountId) {
        if (this.sessions.has(accountId))    return this.sessions.get(accountId);
        if (this.initPromises.has(accountId)) return this.initPromises.get(accountId);

        const initPromise = (async () => {
            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);

                const sock = makeWASocket({
                    auth: state,
                    printQRInTerminal: false,
                    logger: this.logger,
                    browser: Browsers.windows('Enterprise Bot'),
                    syncFullHistory: false,
                    generateHighQualityLinkPreviews: true,
                    markOnlineOnConnect: true,
                });

                sock.ev.on('creds.update', saveCreds);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    if (qr) {
                        console.log(`[Account ${accountId}] QR Code ready.`);
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('qr_code', { qr });
                        }
                    }

                    if (connection === 'close') {
                        const rawError  = lastDisconnect?.error;
                        const statusCode = new Boom.Boom(rawError)?.output?.statusCode;

                        console.error(`[Account ${accountId}] Connection closed. Code: ${statusCode}.`);
                        this.sessions.delete(accountId);

                        // ── الحالة 1: جلسة فاسدة / انتهت → امسح وأعد QR ───────
                        if (BAD_SESSION_CODES.has(statusCode) || statusCode === 500) {
                            await this._clearBadSession(accountId, statusCode);
                            return; // لا تعيد المحاولة هنا، _clearBadSession تتكفل
                        }

                        // ── الحالة 2: انقطاع مؤقت → أعد المحاولة بـ backoff ───
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                            this.io.emit('notification', {
                                type: 'error',
                                title: 'انقطاع الاتصال',
                                message: `انقطع الاتصال بحساب الواتساب (${accountId}).`,
                                accountId
                            });
                        }

                        const attempts = this.reconnectAttempts.get(accountId) || 0;
                        const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                        this.reconnectAttempts.set(accountId, attempts + 1);
                        console.log(`[Account ${accountId}] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
                        setTimeout(() => this.initSession(accountId), delay);

                    } else if (connection === 'open') {
                        console.log(`[Account ${accountId}] Connected successfully.`);
                        this.reconnectAttempts.delete(accountId);
                        await DatabaseManager.systemDB.run(
                            `UPDATE accounts SET status = 'connected', health_status = 'normal' WHERE id = $1`,
                            [accountId]
                        );
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'connected' });
                            this.io.emit('notification', {
                                type: 'success',
                                title: 'تم الاتصال',
                                message: `تم ربط حساب الواتساب بنجاح.`
                            });
                        }
                    }
                });

                sock.ev.on('messages.upsert', async (m) => {
                    if (m.type !== 'notify') return;
                    for (const msg of m.messages) {
                        if (!msg.message) continue;
                        const text = msg.message.conversation
                                  || msg.message.extendedTextMessage?.text
                                  || '';
                        if (text) {
                            const LinkExtractorService = require('../api/services/LinkExtractorService');
                            const senderId = msg.key.participant || msg.key.remoteJid;
                            const groupId  = msg.key.remoteJid.endsWith('@g.us') ? msg.key.remoteJid : null;
                            LinkExtractorService.processMessage(accountId, {
                                text,
                                senderJid: senderId,
                                groupJid: groupId,
                                messageId: msg.key.id
                            }).catch(err => console.error(`[Account ${accountId}] Link extraction failed:`, err));
                        }
                    }
                });

                this.sessions.set(accountId, sock);
                return sock;

            } catch (error) {
                console.error(`[Account ${accountId}] Error initializing session:`, error);
                const attempts = this.reconnectAttempts.get(accountId) || 0;
                const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                this.reconnectAttempts.set(accountId, attempts + 1);
                setTimeout(() => this.initSession(accountId), delay);
                return null;
            } finally {
                this.initPromises.delete(accountId);
            }
        })();

        this.initPromises.set(accountId, initPromise);
        return await initPromise;
    }

    getSession(accountId) {
        return this.sessions.get(accountId);
    }

    // ── Force Reset Session (called from API) ────────────────────────────────
    async forceResetSession(accountId) {
        // أوقف الجلسة الحالية
        const sock = this.sessions.get(accountId);
        if (sock) {
            try { sock.end(undefined); } catch (_) {}
        }
        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId);

        // امسح البيانات من PostgreSQL
        await SystemDB.deleteAllSessionData(accountId).catch(console.error);

        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [accountId]
        ).catch(console.error);

        // أعد التهيئة → QR جديد
        await this.initSession(accountId);
        return true;
    }

    async getGroupMembers(accountId, groupJid) {
        const sock = this.getSession(accountId);
        if (!sock) throw new Error('WhatsApp session not connected.');
        try {
            const metadata = await sock.groupMetadata(groupJid);
            const members  = metadata.participants;
            const result   = {
                groupId:     groupJid,
                groupName:   metadata.subject,
                total:       members.length,
                target_jids: [],
                admins:      []
            };
            for (const member of members) {
                if (member.admin === 'admin' || member.admin === 'superadmin') {
                    result.admins.push(member.id);
                } else {
                    result.target_jids.push(member.id);
                }
            }
            return result;
        } catch (error) {
            console.error(`[Account ${accountId}] Failed to get group metadata:`, error);
            throw new Error('Failed to get group members');
        }
    }

    async getAccountHealth(accountId) {
        const account = await SystemDB.get(
            `SELECT health_status, messages_sent_today, warmup_phase FROM accounts WHERE id = $1`,
            [accountId]
        );
        return account?.health_status || 'normal';
    }
}

module.exports = new WhatsAppManager();
