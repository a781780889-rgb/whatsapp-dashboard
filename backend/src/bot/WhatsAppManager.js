'use strict';
const {
    makeWASocket, DisconnectReason, Browsers,
    initAuthCreds, makeCacheableSignalKeyStore, proto,
    fetchLatestWaWebVersion,
} = require('@whiskeysockets/baileys');
const pino         = require('pino');
const Boom         = require('@hapi/boom');
const SystemDB     = require('../database/SystemDB');
const DatabaseManager = require('../database/DatabaseManager');
const { getRedis } = require('../lib/redis');

// ── Anti-Ban ─────────────────────────────────────────────────────────────────
const ANTI_BAN = {
    maxPerHour:  parseInt(process.env.MAX_MSG_PER_HOUR  || '200',  10),
    minDelay:    parseInt(process.env.MSG_MIN_DELAY_MS  || '2000', 10),
    maxDelay:    parseInt(process.env.MSG_MAX_DELAY_MS  || '8000', 10),
    warmupDays:  parseInt(process.env.WARMUP_DAYS       || '7',    10),
    warmupLimit: parseInt(process.env.WARMUP_LIMIT      || '30',   10),
};

// ── Disconnect codes ──────────────────────────────────────────────────────────
const CLEAR_SESSION_CODES = new Set([
    DisconnectReason.badSession,         // 500
    DisconnectReason.loggedOut,          // 401
    DisconnectReason.connectionReplaced, // 440
]);

const TEMP_DISCONNECT_CODES = new Set([
    DisconnectReason.connectionLost,     // 408
    DisconnectReason.timedOut,           // 408
    DisconnectReason.connectionClosed,   // 428
]);

const QR_SCAN_WINDOW_MS      = 60_000;
const MAX_515_RETRIES        = 5;
const QR_CACHE_TTL_MS        = 55_000; // QR valid for ~60s, cache for 55s
const PAIRING_TIMEOUT_MS     = 45_000; // 45s to get pairing code
const QR_GENERATE_TIMEOUT_MS = 30_000; // 30s to get first QR

// ── Connection States ─────────────────────────────────────────────────────────
// initializing → qr_generating → qr_ready → scanning → connecting → connected
// pairing_starting → pairing_generating → pairing_ready → connecting → connected
// disconnected / error

class WhatsAppManager {
    constructor() {
        this.sessions          = new Map(); // accountId → socket
        this.reconnectAttempts = new Map(); // accountId → number
        this.initPromises      = new Map(); // accountId → Promise
        this.qrSentAt          = new Map(); // accountId → timestamp
        this.lastQrCode        = new Map(); // accountId → { qr, ts }
        this.restartAttempts   = new Map(); // accountId → number
        this.connStates        = new Map(); // accountId → state string
        this.pairingTimers     = new Map(); // accountId → timeout handle
        this.io                = null;
        this.logger            = pino({ level: 'silent' });
    }

    setIO(io) { this.io = io; }

    // ── Emit connection state change ─────────────────────────────────────────
    _emitState(accountId, state, extra = {}) {
        this.connStates.set(accountId, state);
        if (this.io) {
            this.io.to(`account_${accountId}`).emit('connection_state', {
                accountId,
                state,
                ts: Date.now(),
                ...extra,
            });
        }
        console.log(`[Account ${accountId}] State → ${state}`, extra.error ? `(${extra.error})` : '');
    }

    // ── Get current connection state ─────────────────────────────────────────
    getConnectionState(accountId) {
        return this.connStates.get(accountId) || 'disconnected';
    }

    // ── Get cached QR (for late-joining clients) ─────────────────────────────
    getPendingQr(accountId) {
        const cached = this.lastQrCode.get(accountId);
        if (!cached) return null;
        if (Date.now() - cached.ts > QR_CACHE_TTL_MS) {
            this.lastQrCode.delete(accountId);
            return null;
        }
        return cached.qr;
    }

    // ── Get full QR status (for REST endpoint) ────────────────────────────────
    getQrStatus(accountId) {
        const state  = this.getConnectionState(accountId);
        const cached = this.lastQrCode.get(accountId);
        const qr     = cached && (Date.now() - cached.ts < QR_CACHE_TTL_MS) ? cached.qr : null;
        return { state, qr, ts: cached?.ts || null };
    }

    // ── PostgreSQL Auth State ─────────────────────────────────────────────────
    async _usePostgresAuthState(accountId) {
        const DB_KEY_CREDS = 'creds';

        let creds = await SystemDB.getSessionData(accountId, DB_KEY_CREDS);
        if (!creds) creds = initAuthCreds();

        const saveState = async () => {
            await SystemDB.saveSessionData(accountId, DB_KEY_CREDS, creds);
        };

        const keys = {
            async get(type, ids) {
                const result = {};
                await Promise.all(ids.map(async (id) => {
                    const data = await SystemDB.getSessionData(accountId, `keys:${type}:${id}`);
                    if (data != null) {
                        result[id] = (type === 'app-state-sync-key' && data)
                            ? proto.Message.AppStateSyncKeyData.fromObject(data)
                            : data;
                    }
                }));
                return result;
            },
            async set(data) {
                await Promise.all(
                    Object.entries(data).flatMap(([type, typeData]) =>
                        Object.entries(typeData || {}).map(([id, value]) => {
                            const key = `keys:${type}:${id}`;
                            return value
                                ? SystemDB.saveSessionData(accountId, key, value)
                                : SystemDB.deleteSessionData(accountId, key);
                        })
                    )
                );
            }
        };

        return {
            state:     { creds, keys: makeCacheableSignalKeyStore(keys, this.logger) },
            saveCreds: saveState,
        };
    }

    _humanDelay() {
        const ms = ANTI_BAN.minDelay + Math.random() * (ANTI_BAN.maxDelay - ANTI_BAN.minDelay);
        return new Promise(r => setTimeout(r, ms));
    }

    async _checkRateLimit(accountId) {
        try {
            const redis   = getRedis();
            const hourKey = `rate:${accountId}:${Math.floor(Date.now() / 3600000)}`;
            const account = await SystemDB.get(
                `SELECT warmup_phase FROM accounts WHERE id = $1`, [accountId]
            );
            const limit = account?.warmup_phase ? ANTI_BAN.warmupLimit : ANTI_BAN.maxPerHour;
            const count = await redis.incr(hourKey);
            if (count === 1) await redis.expire(hourKey, 3600);
            if (count > limit) {
                await SystemDB.updateAccountHealth(accountId, 'at_risk');
                throw new Error(`[Anti-Ban] Rate limit: ${count}/${limit}`);
            }
            await SystemDB.updateMessageStats(accountId);
            return true;
        } catch (err) {
            if (err.message.includes('Anti-Ban')) throw err;
            console.warn('[Anti-Ban] Redis unavailable:', err.message);
            return true;
        }
    }

    async sendMessageSafe(accountId, to, content) {
        await this._checkRateLimit(accountId);
        await this._humanDelay();
        const sock = this.getSession(accountId);
        if (!sock) throw new Error('WhatsApp session not connected.');
        return sock.sendMessage(to, content);
    }

    // ── مسح جلسة فاسدة ───────────────────────────────────────────────────────
    async _clearSession(accountId, code) {
        console.log(`[Account ${accountId}] Clearing bad session (code ${code})…`);

        // ألغِ مؤقت Pairing إن وُجد
        const pt = this.pairingTimers.get(accountId);
        if (pt) { clearTimeout(pt); this.pairingTimers.delete(accountId); }

        const sock = this.sessions.get(accountId);
        if (sock) { try { sock.end(undefined); } catch (_) {} }

        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId);
        this.restartAttempts.delete(accountId);
        this.qrSentAt.delete(accountId);
        this.lastQrCode.delete(accountId);

        await SystemDB.deleteAllSessionData(accountId).catch(console.error);
        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [accountId]
        ).catch(console.error);

        this._emitState(accountId, 'disconnected', { reason: 'bad_session', code });

        if (this.io) {
            this.io.to(`account_${accountId}`).emit('session_cleared', { accountId });
            this.io.emit('account_status', { accountId, status: 'disconnected', reason: 'bad_session' });
            this.io.emit('notification', {
                type: 'warning',
                title: 'جلسة منتهية',
                message: 'سيظهر رمز QR جديد تلقائياً.',
                accountId,
            });
        }

        // إعادة التهيئة بعد 3 ثوانٍ
        setTimeout(() => this.initSession(accountId), 3000);
    }

    // ── جلب إصدار WA ─────────────────────────────────────────────────────────
    async _fetchWAVersion() {
        try {
            const { version } = await fetchLatestWaWebVersion();
            return version;
        } catch {
            return [2, 3000, 1041235764];
        }
    }

    // ── Init Session (QR Code Flow) ──────────────────────────────────────────
    async initSession(accountId) {
        if (this.sessions.has(accountId))     return this.sessions.get(accountId);
        if (this.initPromises.has(accountId)) return this.initPromises.get(accountId);

        this._emitState(accountId, 'initializing');

        const initPromise = (async () => {
            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);

                const waVersion = await this._fetchWAVersion();
                console.log(`[Account ${accountId}] WA version: ${waVersion.join('.')}`);

                // مؤقت توليد QR (30 ثانية)
                const qrGenTimer = setTimeout(() => {
                    if (this.getConnectionState(accountId) === 'qr_generating') {
                        this._emitState(accountId, 'error', { error: 'انتهت مهلة إنشاء رمز QR. حاول مرة أخرى.' });
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('connection_error', {
                                error: 'انتهت مهلة إنشاء رمز QR (30 ثانية). تأكد من الاتصال بالإنترنت وحاول مرة أخرى.'
                            });
                        }
                    }
                }, QR_GENERATE_TIMEOUT_MS);

                this._emitState(accountId, 'qr_generating');

                const sock = makeWASocket({
                    auth:               state,
                    version:            waVersion,
                    logger:             this.logger,
                    printQRInTerminal:  false,
                    keepAliveIntervalMs: 25_000,
                    connectTimeoutMs:    60_000,
                    qrTimeout:           60_000,
                    browser:             Browsers.ubuntu('Chrome'),
                    syncFullHistory:     false,
                    generateHighQualityLinkPreviews: false,
                    markOnlineOnConnect: false,
                    retryRequestDelayMs: 500,
                    maxRetries:          5,
                });

                sock.ev.on('creds.update', saveCreds);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    // ── QR جديد ──────────────────────────────────────────────
                    if (qr) {
                        clearTimeout(qrGenTimer);
                        console.log(`[Account ${accountId}] QR Code ready.`);
                        this.qrSentAt.set(accountId, Date.now());
                        this.restartAttempts.delete(accountId);
                        this.lastQrCode.set(accountId, { qr, ts: Date.now() });

                        this._emitState(accountId, 'qr_ready');

                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('qr_code', { qr });
                        }
                    }

                    // ── انقطاع ───────────────────────────────────────────────
                    if (connection === 'close') {
                        clearTimeout(qrGenTimer);
                        const statusCode = new Boom.Boom(lastDisconnect?.error)?.output?.statusCode;
                        console.error(`[Account ${accountId}] Connection closed. Code: ${statusCode}.`);
                        this.sessions.delete(accountId);

                        try { require('../api/services/LinkMonitorEngine').markInactive(accountId); } catch {}

                        // جلسة فاسدة
                        if (CLEAR_SESSION_CODES.has(statusCode) || statusCode === 500) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        // restartRequired (515)
                        if (statusCode === DisconnectReason.restartRequired) {
                            const retries515 = (this.restartAttempts.get(accountId) || 0) + 1;
                            this.restartAttempts.set(accountId, retries515);

                            const qrTime             = this.qrSentAt.get(accountId) || 0;
                            const timeSinceQR        = Date.now() - qrTime;
                            const qrWasJustScanned   = timeSinceQR < 90_000;

                            if (retries515 > MAX_515_RETRIES && !qrWasJustScanned) {
                                console.warn(`[Account ${accountId}] 515 repeated ${retries515}x — clearing.`);
                                this.restartAttempts.delete(accountId);
                                await this._clearSession(accountId, 515);
                                return;
                            }

                            const delay515 = qrWasJustScanned ? 3000 : Math.min(retries515 * 5000, 20000);
                            console.log(`[Account ${accountId}] Restart required (515) — attempt ${retries515}/${MAX_515_RETRIES}. Reconnecting in ${delay515}ms…`);

                            if (qrWasJustScanned) {
                                this._emitState(accountId, 'connecting');
                                console.log(`[Account ${accountId}] QR was just scanned — saving creds and reconnecting.`);
                                await saveCreds().catch(() => {});
                            } else if (!state.creds?.registered) {
                                await SystemDB.deleteAllSessionData(accountId).catch(() => {});
                            } else {
                                await saveCreds().catch(() => {});
                            }

                            setTimeout(() => this.initSession(accountId), delay515);
                            return;
                        }

                        // انقطاع مؤقت (408 / 428)
                        if (TEMP_DISCONNECT_CODES.has(statusCode)) {
                            const lastQR  = this.qrSentAt.get(accountId) || 0;
                            const elapsed = Date.now() - lastQR;

                            if (elapsed < QR_SCAN_WINDOW_MS) {
                                const remaining = QR_SCAN_WINDOW_MS - elapsed + 2000;
                                this._emitState(accountId, 'connecting');
                                console.log(`[Account ${accountId}] QR pending — waiting ${remaining}ms before reconnect.`);
                                setTimeout(() => this.initSession(accountId), remaining);
                            } else {
                                const attempts = this.reconnectAttempts.get(accountId) || 0;
                                const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                                this.reconnectAttempts.set(accountId, attempts + 1);
                                this._emitState(accountId, 'disconnected', { reason: statusCode });
                                console.log(`[Account ${accountId}] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
                                setTimeout(() => this.initSession(accountId), delay);
                            }

                            if (this.io) {
                                this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                            }
                            return;
                        }

                        // أي كود آخر
                        const attempts = this.reconnectAttempts.get(accountId) || 0;
                        const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                        this.reconnectAttempts.set(accountId, attempts + 1);
                        this._emitState(accountId, 'disconnected', { reason: statusCode });
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                        }
                        console.log(`[Account ${accountId}] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
                        setTimeout(() => this.initSession(accountId), delay);
                    }

                    // ── اتصال ناجح ────────────────────────────────────────────
                    if (connection === 'open') {
                        clearTimeout(qrGenTimer);
                        console.log(`[Account ${accountId}] Connected successfully.`);
                        this.reconnectAttempts.delete(accountId);
                        this.restartAttempts.delete(accountId);
                        this.qrSentAt.delete(accountId);
                        this.lastQrCode.delete(accountId);

                        this._emitState(accountId, 'connected');

                        await DatabaseManager.systemDB.run(
                            `UPDATE accounts SET status = 'connected', health_status = 'normal' WHERE id = $1`,
                            [accountId]
                        );

                        try {
                            const LinkMonitorEngine = require('../api/services/LinkMonitorEngine');
                            LinkMonitorEngine.markActive(accountId);
                        } catch {}

                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'connected' });
                            this.io.emit('notification', {
                                type: 'success',
                                title: '✅ تم الاتصال',
                                message: 'تم ربط حساب الواتساب بنجاح.',
                            });
                        }
                    }
                });

                // ── رسائل واردة ──────────────────────────────────────────────
                sock.ev.on('messages.upsert', async (m) => {
                    if (m.type !== 'notify') return;
                    for (const msg of m.messages) {
                        if (!msg.message) continue;
                        const text = msg.message.conversation
                                  || msg.message.extendedTextMessage?.text
                                  || msg.message.imageMessage?.caption
                                  || msg.message.videoMessage?.caption
                                  || msg.message.documentMessage?.caption
                                  || '';
                        if (text) {
                            const LinkExtractorService = require('../api/services/LinkExtractorService');
                            const senderId = msg.key.participant || msg.key.remoteJid;
                            const groupId  = msg.key.remoteJid?.endsWith('@g.us') ? msg.key.remoteJid : null;
                            LinkExtractorService.processMessage(accountId, {
                                text, senderJid: senderId, groupJid: groupId, messageId: msg.key.id
                            }).catch(err => console.error(`[Account ${accountId}] Link extraction failed:`, err));
                        }
                    }
                });

                this.sessions.set(accountId, sock);
                return sock;

            } catch (error) {
                console.error(`[Account ${accountId}] Init error:`, error);
                this._emitState(accountId, 'error', { error: error.message });
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

    getSession(accountId) { return this.sessions.get(accountId); }

    // ── Pairing Code Session ─────────────────────────────────────────────────
    //
    // 🔑 الإصلاح الجوهري:
    //    requestPairingCode يجب أن يُستدعى عند ظهور حدث `qr` في connection.update
    //    وليس عند connection === 'open' (كان هذا هو الخطأ الأصلي الذي يسبب
    //    "جاري إنشاء الرمز..." إلى ما لا نهاية).
    //
    //    السبب: Baileys يولّد QR أولاً. استدعاء requestPairingCode عند هذه اللحظة
    //    يُخبر WhatsApp بتحويل التسجيل من QR إلى Pairing Code بدلاً من ذلك.
    //    عند connection === 'open' يكون الاتصال قد اكتمل بالفعل — لا معنى
    //    لطلب pairing code بعدها.
    //
    async initPairingSession(accountId, phoneNumber) {
        // إنهاء أي جلسة قائمة
        const old = this.sessions.get(accountId);
        if (old) {
            try { old.end(undefined); } catch {}
            this.sessions.delete(accountId);
        }
        this.initPromises.delete(accountId);

        // إلغاء مؤقت pairing سابق
        const existingTimer = this.pairingTimers.get(accountId);
        if (existingTimer) { clearTimeout(existingTimer); this.pairingTimers.delete(accountId); }

        // مسح جلسة قديمة لضمان جلسة نظيفة
        await SystemDB.deleteAllSessionData(accountId).catch(() => {});

        this._emitState(accountId, 'pairing_starting');

        const initPromise = (async () => {
            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);
                const waVersion            = await this._fetchWAVersion();
                console.log(`[Account ${accountId}][Pairing] WA version: ${waVersion.join('.')}`);

                const sock = makeWASocket({
                    auth:               state,
                    version:            waVersion,
                    logger:             this.logger,
                    printQRInTerminal:  false,
                    keepAliveIntervalMs: 25_000,
                    connectTimeoutMs:    60_000,
                    browser:             Browsers.ubuntu('Chrome'),
                    syncFullHistory:     false,
                    markOnlineOnConnect: false,
                    retryRequestDelayMs: 500,
                    maxRetries:          5,
                });

                sock.ev.on('creds.update', saveCreds);

                let pairingRequested = false;

                // ── مؤقت Pairing Code (45 ثانية) ────────────────────────────
                const pairingTimer = setTimeout(() => {
                    if (!pairingRequested) {
                        // لم يأت QR event بعد 45 ثانية — خطأ شبكة
                        this._emitState(accountId, 'error', {
                            error: 'انتهت المهلة. تأكد من الاتصال بالإنترنت ومن صحة رقم الهاتف.',
                        });
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('pairing_error', {
                                error: 'انتهت مهلة إنشاء رمز الإقران (45 ثانية). تحقق من الإنترنت وحاول مرة أخرى.',
                            });
                        }
                        try { sock.end(undefined); } catch {}
                    }
                    this.pairingTimers.delete(accountId);
                }, PAIRING_TIMEOUT_MS);

                this.pairingTimers.set(accountId, pairingTimer);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    // ✅ الإصلاح الجوهري: استدعاء requestPairingCode عند ظهور حدث QR
                    //    وليس عند connection === 'open'
                    if (qr && !pairingRequested) {
                        pairingRequested = true;
                        clearTimeout(pairingTimer);
                        this.pairingTimers.delete(accountId);

                        this._emitState(accountId, 'pairing_generating');
                        console.log(`[Account ${accountId}][Pairing] QR event intercepted — requesting pairing code for ${phoneNumber}...`);

                        try {
                            const code      = await sock.requestPairingCode(phoneNumber);
                            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

                            console.log(`[Account ${accountId}][Pairing] ✅ Pairing Code: ${formatted}`);

                            this._emitState(accountId, 'pairing_ready', { code: formatted });

                            if (this.io) {
                                this.io.to(`account_${accountId}`).emit('pairing_code', {
                                    code:  formatted,
                                    phone: phoneNumber,
                                });
                            }
                        } catch (err) {
                            console.error(`[Account ${accountId}][Pairing] requestPairingCode error:`, err.message);
                            this._emitState(accountId, 'error', { error: err.message });
                            if (this.io) {
                                this.io.to(`account_${accountId}`).emit('pairing_error', {
                                    error: `فشل إنشاء رمز الإقران: ${err.message}`,
                                });
                            }
                        }
                        return;
                    }

                    // انقطاع
                    if (connection === 'close') {
                        clearTimeout(pairingTimer);
                        this.pairingTimers.delete(accountId);

                        const statusCode = new Boom.Boom(lastDisconnect?.error)?.output?.statusCode;
                        console.log(`[Account ${accountId}][Pairing] Connection closed. Code: ${statusCode}`);
                        this.sessions.delete(accountId);
                        this.initPromises.delete(accountId);

                        // تسجيل خروج أو جلسة فاسدة
                        if (CLEAR_SESSION_CODES.has(statusCode)) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        // إذا كان الـ pairing code قد أُرسل → المستخدم لم يدخله بعد
                        // أعد الاتصال للانتظار
                        if (pairingRequested && statusCode === DisconnectReason.restartRequired) {
                            this._emitState(accountId, 'connecting');
                            console.log(`[Account ${accountId}][Pairing] Reconnecting to complete pairing...`);
                            await saveCreds().catch(() => {});
                            setTimeout(() => this.initSession(accountId), 3000);
                            return;
                        }

                        // خطأ شبكة → أعد المحاولة
                        const attempts = (this.reconnectAttempts.get(accountId) || 0) + 1;
                        this.reconnectAttempts.set(accountId, attempts);
                        const delay = Math.min(attempts * 3000, 15000);

                        this._emitState(accountId, 'disconnected', { reason: statusCode, attempt: attempts });

                        if (attempts <= 3) {
                            console.log(`[Account ${accountId}][Pairing] Retrying in ${delay}ms (attempt ${attempts})...`);
                            // إعادة المحاولة كـ pairing بنفس الرقم
                            setTimeout(() => this.initPairingSession(accountId, phoneNumber), delay);
                        } else {
                            this._emitState(accountId, 'error', {
                                error: `فشل الاتصال بعد ${attempts} محاولات. تحقق من الإنترنت وحاول مرة أخرى.`,
                            });
                            if (this.io) {
                                this.io.to(`account_${accountId}`).emit('pairing_error', {
                                    error: `فشل الاتصال بعد ${attempts} محاولات (كود: ${statusCode}). تحقق من الإنترنت.`,
                                });
                            }
                        }
                        return;
                    }

                    // متصل بنجاح
                    if (connection === 'open') {
                        clearTimeout(pairingTimer);
                        this.pairingTimers.delete(accountId);

                        console.log(`[Account ${accountId}][Pairing] ✅ Connected successfully via Pairing Code.`);

                        this.reconnectAttempts.delete(accountId);
                        this.restartAttempts.delete(accountId);
                        this.sessions.set(accountId, sock);

                        this._emitState(accountId, 'connected');

                        await DatabaseManager.systemDB.run(
                            `UPDATE accounts SET status = 'connected', health_status = 'normal',
                             connection_type = 'pairing_code', phone_number = $1, updated_at = NOW()
                             WHERE id = $2`,
                            [phoneNumber, accountId]
                        ).catch(console.error);

                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'connected' });
                            this.io.to(`account_${accountId}`).emit('account_status', {
                                accountId, status: 'connected',
                            });
                            this.io.emit('notification', {
                                type:    'success',
                                title:   '✅ تم الاتصال',
                                message: 'تم ربط الحساب عبر رمز الإقران بنجاح.',
                            });
                        }

                        // تفعيل مراقبة الروابط
                        try {
                            const LinkMonitorEngine = require('../api/services/LinkMonitorEngine');
                            LinkMonitorEngine.markActive(accountId);
                        } catch {}
                    }
                });

                this.sessions.set(accountId, sock);
                return sock;

            } catch (err) {
                this.initPromises.delete(accountId);
                const pt = this.pairingTimers.get(accountId);
                if (pt) { clearTimeout(pt); this.pairingTimers.delete(accountId); }

                console.error(`[Account ${accountId}][Pairing] initPairingSession error:`, err.message);
                this._emitState(accountId, 'error', { error: err.message });

                if (this.io) {
                    this.io.to(`account_${accountId}`).emit('pairing_error', {
                        error: `خطأ داخلي: ${err.message}`,
                    });
                }
                throw err;
            }
        })();

        this.initPromises.set(accountId, initPromise);
        return await initPromise;
    }

    // ── Force Reset ───────────────────────────────────────────────────────────
    async forceResetSession(accountId) {
        await this._clearSession(accountId, 'force_reset');
        return true;
    }

    async getGroupMembers(accountId, groupJid) {
        const sock = this.getSession(accountId);
        if (!sock) throw new Error('WhatsApp session not connected.');
        try {
            const metadata = await sock.groupMetadata(groupJid);
            const members  = metadata.participants;
            return {
                groupId:     groupJid,
                groupName:   metadata.subject,
                total:       members.length,
                target_jids: members.filter(m => !m.admin).map(m => m.id),
                admins:      members.filter(m => m.admin).map(m => m.id),
            };
        } catch (error) {
            console.error(`[Account ${accountId}] groupMetadata error:`, error);
            throw new Error('Failed to get group members');
        }
    }

    async getAccountHealth(accountId) {
        const account = await SystemDB.get(
            `SELECT health_status FROM accounts WHERE id = $1`, [accountId]
        );
        return account?.health_status || 'normal';
    }

    async sendTextMessage(accountId, groupJid, text) {
        return this.sendMessageSafe(accountId, groupJid, { text });
    }
}

module.exports = new WhatsAppManager();
