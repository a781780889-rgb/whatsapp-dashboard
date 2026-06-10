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

// ── Disconnect codes classification ─────────────────────────────────────────
// جلسة فاسدة → امسح كل شيء واطلب QR جديد
const CLEAR_SESSION_CODES = new Set([
    DisconnectReason.badSession,         // 500
    DisconnectReason.loggedOut,          // 401
    DisconnectReason.connectionReplaced, // 440
]);

// انقطاع مؤقت → أعد الاتصال بدون مسح الجلسة
const TEMP_DISCONNECT_CODES = new Set([
    DisconnectReason.connectionLost,     // 408 - شبكة مؤقتة
    DisconnectReason.timedOut,           // 408
    DisconnectReason.connectionClosed,   // 428
]);

// ── QR scan window ───────────────────────────────────────────────────────────
// مدة الانتظار بعد إرسال QR قبل قبول أي reconnect (بالمللي ثانية)
const QR_SCAN_WINDOW_MS = 60_000; // 60 ثانية (Railway يكون بطيئاً أحياناً)
// الحد الأقصى لمحاولات 515 قبل مسح الجلسة
const MAX_515_RETRIES = 5; // زيادة من 3 إلى 5 لتحمّل تأخيرات Railway

class WhatsAppManager {
    constructor() {
        this.sessions          = new Map(); // accountId → socket
        this.reconnectAttempts = new Map(); // accountId → number
        this.initPromises      = new Map(); // accountId → Promise
        this.qrSentAt          = new Map(); // accountId → timestamp
        this.lastQrCode        = new Map(); // accountId → { qr, ts } — cache QR for late-joining clients
        this.restartAttempts   = new Map(); // accountId → number — عداد محاولات 515
        this.io                = null;
        this.logger            = pino({ level: 'silent' });
    }

    setIO(io) { this.io = io; }

    // ✅ FIX: Returns cached QR if still fresh (< 45 seconds old)
    getPendingQr(accountId) {
        const cached = this.lastQrCode.get(accountId);
        if (!cached) return null;
        const age = Date.now() - cached.ts;
        if (age > 44_000) {
            this.lastQrCode.delete(accountId); // expired
            return null;
        }
        return cached.qr;
    }

    // ── PostgreSQL Auth State ────────────────────────────────────────────────
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

    // ── Human-like delay ─────────────────────────────────────────────────────
    _humanDelay() {
        const ms = ANTI_BAN.minDelay + Math.random() * (ANTI_BAN.maxDelay - ANTI_BAN.minDelay);
        return new Promise(r => setTimeout(r, ms));
    }

    // ── Rate limiting ────────────────────────────────────────────────────────
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

        const sock = this.sessions.get(accountId);
        if (sock) { try { sock.end(undefined); } catch (_) {} }

        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId);
        this.restartAttempts.delete(accountId);    // ✅ امسح عداد 515
        this.qrSentAt.delete(accountId);
        this.lastQrCode.delete(accountId); // ✅ FIX: Clear QR cache

        await SystemDB.deleteAllSessionData(accountId).catch(console.error);
        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [accountId]
        ).catch(console.error);

        if (this.io) {
            this.io.emit('account_status', { accountId, status: 'disconnected', reason: 'bad_session' });
            this.io.to(`account_${accountId}`).emit('session_cleared', { accountId });
            this.io.emit('notification', {
                type: 'warning',
                title: 'جلسة منتهية',
                message: 'سيظهر رمز QR جديد تلقائياً.',
                accountId
            });
        }

        // إعادة التهيئة بعد 3 ثوانٍ → credentials جديدة → QR جديد
        setTimeout(() => this.initSession(accountId), 3000);
    }

    // ── Init Session ─────────────────────────────────────────────────────────
    async initSession(accountId) {
        if (this.sessions.has(accountId))     return this.sessions.get(accountId);
        if (this.initPromises.has(accountId)) return this.initPromises.get(accountId);

        const initPromise = (async () => {
            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);

                // ✅ FIX: جلب أحدث إصدار WhatsApp Web — يمنع رفض الاتصال بـ 515
                let waVersion;
                try {
                    const { version } = await fetchLatestWaWebVersion();
                    waVersion = version;
                    console.log(`[Account ${accountId}] WA version: ${version.join('.')}`);
                } catch {
                    // fallback إذا فشل الجلب (لا إنترنت مؤقتاً)
                    waVersion = [2, 3000, 1015901307];
                }

                const sock = makeWASocket({
                    auth:      state,
                    version:   waVersion,
                    logger:    this.logger,
                    printQRInTerminal: false,

                    // ─── إعدادات الاستقرار على Railway ────────────────────────
                    keepAliveIntervalMs: 25_000,  // 25 ثانية (10 ثانية كانت مفرطة)
                    connectTimeoutMs:    60_000,
                    qrTimeout:           60_000,  // 60 ثانية لمسح الـ QR (كانت 45 قصيرة جداً)

                    // browser يشبه Chrome العادي → أقل احتمالية للحظر
                    browser: Browsers.ubuntu('Chrome'),

                    syncFullHistory:               false,
                    generateHighQualityLinkPreviews: false,
                    markOnlineOnConnect:            false,
                    retryRequestDelayMs:            500,
                    maxRetries:                     5,  // زيادة المحاولات
                });

                sock.ev.on('creds.update', saveCreds);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    // ── QR جديد ─────────────────────────────────────────────
                    if (qr) {
                        console.log(`[Account ${accountId}] QR Code ready.`);
                        this.qrSentAt.set(accountId, Date.now());
                        this.restartAttempts.delete(accountId); // ✅ QR جديد = جلسة نظيفة → صفّر العداد
                        // ✅ FIX: Cache QR so late-joining clients can receive it
                        this.lastQrCode.set(accountId, { qr, ts: Date.now() });
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('qr_code', { qr });
                        }
                    }

                    // ── انقطاع ──────────────────────────────────────────────
                    if (connection === 'close') {
                        const statusCode = new Boom.Boom(lastDisconnect?.error)?.output?.statusCode;
                        console.error(`[Account ${accountId}] Connection closed. Code: ${statusCode}.`);
                        this.sessions.delete(accountId);
                        // إيقاف مراقبة هذا الحساب
                        try { require('../api/services/LinkMonitorEngine').markInactive(accountId); } catch {}

                        // 1. جلسة فاسدة أو تسجيل خروج → امسح وأعد QR
                        if (CLEAR_SESSION_CODES.has(statusCode) || statusCode === 500) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        // 2. restartRequired (515) → أعد الاتصال بدون مسح (مع حد أقصى)
                        if (statusCode === DisconnectReason.restartRequired) {
                            const retries515 = (this.restartAttempts.get(accountId) || 0) + 1;
                            this.restartAttempts.set(accountId, retries515);

                            // هل تم مسح QR مؤخراً؟ (خلال آخر 90 ثانية)
                            const qrTime = this.qrSentAt.get(accountId) || 0;
                            const timeSinceQR = Date.now() - qrTime;
                            const QR_JUST_SCANNED_WINDOW_MS = 90_000; // 90 ثانية
                            const qrWasJustScanned = timeSinceQR < QR_JUST_SCANNED_WINDOW_MS;

                            // إذا تكرر 515 أكثر من MAX_515_RETRIES وليس في نافذة المسح → الجلسة تالفة
                            if (retries515 > MAX_515_RETRIES && !qrWasJustScanned) {
                                console.warn(`[Account ${accountId}] 515 repeated ${retries515}x — clearing session.`);
                                this.restartAttempts.delete(accountId);
                                await this._clearSession(accountId, 515);
                                return;
                            }

                            // Backoff: 3s → 5s → 8s (أسرع استجابة بعد مسح QR)
                            const delay515 = qrWasJustScanned ? 3000 : Math.min(retries515 * 5000, 20000);
                            console.log(`[Account ${accountId}] Restart required (515) — attempt ${retries515}/${MAX_515_RETRIES}. Reconnecting in ${delay515}ms… (QR scanned ${Math.round(timeSinceQR/1000)}s ago)`);

                            if (qrWasJustScanned) {
                                // ✅ FIX CORE: المستخدم مسح QR للتو — 515 طبيعي بعد المسح
                                // يجب حفظ الـ creds وإعادة الاتصال لاستكمال التسجيل
                                // لا تمسح الجلسة هنا أبداً!
                                console.log(`[Account ${accountId}] QR was just scanned — saving creds and reconnecting to complete registration.`);
                                await saveCreds().catch(() => {});
                            } else if (!state.creds?.registered) {
                                // لم يتم مسح QR ولم تكتمل الجلسة → امسح البيانات الجزئية
                                console.log(`[Account ${accountId}] Session not registered and no recent QR scan — wiping partial auth data.`);
                                await SystemDB.deleteAllSessionData(accountId).catch(() => {});
                            } else {
                                // جلسة مسجّلة سابقاً → احفظ الـ creds بأمان
                                await saveCreds().catch(() => {});
                            }

                            setTimeout(() => this.initSession(accountId), delay515);
                            return;
                        }

                        // 3. انقطاع مؤقت (408 / 428) → تحقق من نافذة QR أولاً
                        if (TEMP_DISCONNECT_CODES.has(statusCode)) {
                            const lastQR = this.qrSentAt.get(accountId) || 0;
                            const elapsed = Date.now() - lastQR;

                            if (elapsed < QR_SCAN_WINDOW_MS) {
                                // المستخدم ربما يمسح الآن → انتظر أكثر
                                const remaining = QR_SCAN_WINDOW_MS - elapsed + 2000;
                                console.log(`[Account ${accountId}] QR pending — waiting ${remaining}ms before reconnect.`);
                                setTimeout(() => this.initSession(accountId), remaining);
                            } else {
                                // لا يوجد QR نشط → أعد الاتصال بـ backoff عادي
                                const attempts = this.reconnectAttempts.get(accountId) || 0;
                                const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                                this.reconnectAttempts.set(accountId, attempts + 1);
                                console.log(`[Account ${accountId}] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
                                setTimeout(() => this.initSession(accountId), delay);
                            }

                            if (this.io) {
                                this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                            }
                            return;
                        }

                        // 4. أي كود آخر → backoff عادي
                        const attempts = this.reconnectAttempts.get(accountId) || 0;
                        const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                        this.reconnectAttempts.set(accountId, attempts + 1);
                        console.log(`[Account ${accountId}] Reconnecting in ${delay}ms (attempt ${attempts + 1})`);
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                        }
                        setTimeout(() => this.initSession(accountId), delay);
                    }

                    // ── اتصال ناجح ───────────────────────────────────────────
                    if (connection === 'open') {
                        console.log(`[Account ${accountId}] Connected successfully.`);
                        this.reconnectAttempts.delete(accountId);
                        this.restartAttempts.delete(accountId);   // ✅ امسح عداد 515
                        this.qrSentAt.delete(accountId);
                        this.lastQrCode.delete(accountId); // ✅ FIX: Clear QR cache on success
                        await DatabaseManager.systemDB.run(
                            `UPDATE accounts SET status = 'connected', health_status = 'normal' WHERE id = $1`,
                            [accountId]
                        );
                        // تفعيل محرك المراقبة للحساب
                        try {
                            const LinkMonitorEngine = require('../api/services/LinkMonitorEngine');
                            LinkMonitorEngine.markActive(accountId);
                        } catch {}
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'connected' });
                            this.io.emit('notification', {
                                type: 'success',
                                title: 'تم الاتصال',
                                message: 'تم ربط حساب الواتساب بنجاح.'
                            });
                        }
                    }
                });

                // ── مراقبة الرسائل الواردة (الجزء الثالث) ───────────────────
                sock.ev.on('messages.upsert', async (m) => {
                    if (m.type !== 'notify') return;
                    for (const msg of m.messages) {
                        if (!msg.message) continue;
                        // استخراج النص من كل أنواع الرسائل
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

    // ── Pairing Code Session — ربط عبر رمز الإقران ──────────────────────────
    async initPairingSession(accountId, phoneNumber) {
        // إذا كانت هناك جلسة نشطة، أنهها أولاً
        const old = this.sessions.get(accountId);
        if (old) {
            try { old.end(undefined); } catch {}
            this.sessions.delete(accountId);
            this.initPromises.delete(accountId);
        }

        // مسح بيانات الجلسة القديمة لضمان جلسة نظيفة
        await SystemDB.deleteAllSessionData(accountId).catch(() => {});

        const initPromise = (async () => {
            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);

                let waVersion;
                try {
                    const { version } = await fetchLatestWaWebVersion();
                    waVersion = version;
                } catch {
                    waVersion = [2, 3000, 1015901307];
                }

                const sock = makeWASocket({
                    auth:   state,
                    version: waVersion,
                    logger: this.logger,
                    printQRInTerminal: false,
                    keepAliveIntervalMs: 25_000,
                    connectTimeoutMs:    60_000,
                    browser: Browsers.ubuntu('Chrome'),
                    syncFullHistory:  false,
                    markOnlineOnConnect: false,
                    retryRequestDelayMs: 500,
                    maxRetries: 5,
                });

                sock.ev.on('creds.update', saveCreds);

                // ── طلب Pairing Code بعد فتح المقبس مباشرة ──────────────────
                let pairingRequested = false;
                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    // عند الاتصال: اطلب الـ Pairing Code
                    if (connection === 'open' && !pairingRequested) {
                        pairingRequested = true;
                        try {
                            const code = await sock.requestPairingCode(phoneNumber);
                            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;
                            console.log(`[Account ${accountId}] Pairing Code: ${formatted}`);
                            if (this.io) {
                                this.io.to(`account_${accountId}`).emit('pairing_code', {
                                    code: formatted,
                                    phone: phoneNumber
                                });
                            }
                        } catch (err) {
                            console.error(`[Account ${accountId}] requestPairingCode error:`, err.message);
                            if (this.io) {
                                this.io.to(`account_${accountId}`).emit('pairing_error', {
                                    error: 'فشل إنشاء Pairing Code: ' + err.message
                                });
                            }
                        }
                        return;
                    }

                    // إذا ظهر QR بدل Pairing → لا نتوقع هذا لكن نعالجه
                    if (qr) {
                        console.log(`[Account ${accountId}] Unexpected QR during pairing session.`);
                    }

                    // انقطاع
                    if (connection === 'close') {
                        const statusCode = new Boom.Boom(lastDisconnect?.error)?.output?.statusCode;
                        this.sessions.delete(accountId);

                        if (CLEAR_SESSION_CODES.has(statusCode)) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        const attempts = (this.reconnectAttempts.get(accountId) || 0) + 1;
                        this.reconnectAttempts.set(accountId, attempts);
                        const delay = Math.min(attempts * 3000, 30000);
                        console.log(`[Account ${accountId}][Pairing] Reconnecting in ${delay}ms...`);
                        setTimeout(() => this.initSession(accountId), delay);
                        return;
                    }

                    // متصل بنجاح
                    if (connection === 'open') {
                        this.reconnectAttempts.delete(accountId);
                        this.restartAttempts.delete(accountId);
                        this.sessions.set(accountId, sock);

                        await SystemDB.run(
                            `UPDATE accounts SET status = 'connected', connection_type = 'pairing_code',
                             phone_number = $1, updated_at = NOW() WHERE id = $2`,
                            [phoneNumber, accountId]
                        );

                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('account_status', {
                                accountId, status: 'connected'
                            });
                        }
                        console.log(`[Account ${accountId}] Connected via Pairing Code ✓`);
                    }
                });

                this.sessions.set(accountId, sock);
                this.initPromises.set(accountId, initPromise);
                return sock;
            } catch (err) {
                this.initPromises.delete(accountId);
                console.error(`[Account ${accountId}][Pairing] initPairingSession error:`, err.message);
                throw err;
            }
        })();

        this.initPromises.set(accountId, initPromise);
        return await initPromise;
    }

    // ── Force Reset (من API) ─────────────────────────────────────────────────
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

    // ── Private Campaigns: إرسال نص إلى مجموعة مباشرةً ─────────────────────
    async sendTextMessage(accountId, groupJid, text) {
        return this.sendMessageSafe(accountId, groupJid, { text });
    }
}

module.exports = new WhatsAppManager();
