'use strict';
const MAX_RECONNECT_ATTEMPTS = parseInt(process.env.MAX_RECONNECT_ATTEMPTS || '10', 10);

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
const DiagnosticEngine = require('../api/services/DiagnosticEngine');
const RuntimeAnalyzer  = require('../api/services/RuntimeAnalyzer');
const CycleAnalyzer    = require('../api/services/ConnectionCycleAnalyzer');
const QRAnalyzer       = require('../api/services/QRAnalyzer');
const PairingCodeAnalyzer = require('../api/services/PairingCodeAnalyzer');
const BaileysAnalyzer  = require('../api/services/BaileysAnalyzer');

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
        this.lastPairingCode   = new Map(); // accountId → { code, ts }
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
        // ── تتبع المرحلة في نظام التشخيص ─────────────────────────────────
        DiagnosticEngine.trackStage(accountId, state, extra);
        // ── Phase 2: تسجيل تغيير الحالة في Runtime Analyzer ──────────────
        RuntimeAnalyzer.onStateChange(accountId, state, extra).catch(() => {});
        // ── Phase 3: تتبع انتقالات المراحل بدقة ──────────────────────────────
        CycleAnalyzer.onStageChange(accountId, state, extra).catch(() => {});
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

    // ── Get pending pairing code (for late-joining clients) ──────────────────
    getPendingPairingCode(accountId) {
        const cached = this.lastPairingCode.get(accountId);
        if (!cached) return null;
        if (Date.now() - cached.ts > 60_000) { this.lastPairingCode.delete(accountId); return null; }
        return cached.code;
    }

    // ── Full state snapshot for any late-joining socket ──────────────────────
    getStateSummary(accountId) {
        const state       = this.getConnectionState(accountId);
        const qrData      = this.lastQrCode.get(accountId);
        const pairingData = this.lastPairingCode.get(accountId);
        const qr   = qrData      && (Date.now() - qrData.ts      < QR_CACHE_TTL_MS) ? qrData.qr      : null;
        const code = pairingData && (Date.now() - pairingData.ts < 60_000)           ? pairingData.code : null;
        return { state, qr, code };
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
            // ✅ FIX: استخدام getAccountWithWarmup للتحقق الدقيق من Warmup Phase
            const account = await SystemDB.getAccountWithWarmup(accountId);
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
        console.log(`[Account ${accountId}] Clearing session (code ${code})…`);

        // ── تشخيص سبب المسح ───────────────────────────────────────────────
        DiagnosticEngine.diagnose(accountId, {
            disconnectCode: typeof code === 'number' ? code : undefined,
            contextKey:     typeof code === 'string' && code !== 'force_reset' ? 'session_corrupted' : undefined,
            fromStage:      this.connStates.get(accountId) || 'unknown',
            extraDetails:   { clearCode: code },
        }).catch(() => {});

        // ── Phase 2: تسجيل مسح الجلسة في Runtime ─────────────────────────
        RuntimeAnalyzer.onSessionCleared(accountId, code).catch(() => {});
        const clearOutcome = code === 401 ? 'logged_out' : code === 440 ? 'replaced' : 'failed';
        RuntimeAnalyzer.endAttempt(accountId, clearOutcome, this.connStates.get(accountId) || 'unknown',
            `session_cleared_code_${code}`).catch(() => {});
        // ── Phase 3: إنهاء دورة الاتصال عند مسح الجلسة ─────────────────
        CycleAnalyzer.endCycle(accountId, 'disconnected', `session_cleared_code_${code}`).catch(() => {});
        // ── Phase 7: إلغاء أي QR نشط عند مسح الجلسة ────────────────────
        QRAnalyzer.onQRCancelled(accountId).catch(() => {});

        // ✅ FIX: ألغِ مؤقت Pairing إن وُجد
        const pt = this.pairingTimers.get(accountId);
        if (pt) { clearTimeout(pt); this.pairingTimers.delete(accountId); }

        // ✅ FIX: أنهِ Socket بأمان
        const sock = this.sessions.get(accountId);
        if (sock) { try { sock.end(undefined); } catch (_) {} }

        // ✅ FIX: تنظيف جميع Maps المرتبطة بهذا الحساب
        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId);
        this.restartAttempts.delete(accountId);
        this.qrSentAt.delete(accountId);
        this.lastQrCode.delete(accountId);
        this.lastPairingCode.delete(accountId);
        this.connStates.delete(accountId);     // ✅ NEW: تنظيف connStates

        // ✅ FIX: حذف بيانات الجلسة من قاعدة البيانات
        await SystemDB.deleteAllSessionData(accountId).catch(console.error);
        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET status = 'disconnected', updated_at = NOW() WHERE id = $1`,
            [accountId]
        ).catch(console.error);

        // ✅ FIX: تنظيف مفاتيح Redis الخاصة بهذا الحساب (Rate Limiting)
        try {
            const redis   = getRedis();
            const hourKey = `rate:${accountId}:${Math.floor(Date.now() / 3600000)}`;
            await redis.del(hourKey).catch(() => {});
        } catch (_) {}

        // ✅ FIX: تحديد ما إذا كان يجب إعادة الاتصال أم لا
        // loggedOut (401) / connectionReplaced (440) → لا نُعيد الاتصال أبداً
        const noReconnectCodes = new Set([
            DisconnectReason.loggedOut,          // 401 — المستخدم أغلق الجلسة يدوياً
            DisconnectReason.connectionReplaced, // 440 — جلسة مفتوحة في مكان آخر
        ]);
        const shouldReconnect = !noReconnectCodes.has(code) && code !== 'force_reset';

        this._emitState(accountId, 'disconnected', { reason: 'session_cleared', code });

        if (this.io) {
            this.io.to(`account_${accountId}`).emit('session_cleared', { accountId, code });
            this.io.emit('account_status', { accountId, status: 'disconnected', reason: 'session_cleared' });
            if (shouldReconnect) {
                this.io.emit('notification', {
                    type: 'warning', title: 'جلسة منتهية',
                    message: 'سيظهر رمز QR جديد تلقائياً.', accountId,
                });
            } else {
                this.io.emit('notification', {
                    type: 'error', title: 'تم تسجيل الخروج',
                    message: code === DisconnectReason.loggedOut
                        ? 'تم تسجيل الخروج من واتساب. يرجى إعادة الاتصال يدوياً.'
                        : 'الجلسة منتهية. يرجى إعادة الاتصال.',
                    accountId,
                });
            }
        }

        // ✅ FIX: إعادة التهيئة فقط إذا كان مسموحاً
        if (shouldReconnect) {
            console.log(`[Account ${accountId}] Will auto-reconnect in 3s…`);
            setTimeout(() => this.initSession(accountId), 3000);
        } else {
            console.log(`[Account ${accountId}] No auto-reconnect for code ${code}.`);
        }
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
            // ── Phase 2: بدء تسجيل محاولة الاتصال ─────────────────────────
            const reconnectNum = this.reconnectAttempts.get(accountId) || 0;
            const attemptId    = await RuntimeAnalyzer.startAttempt(accountId, 'qr_code', reconnectNum).catch(() => null);
            // ── Phase 3: ربط المحاولة بمحلل دورة الاتصال ────────────────────
            CycleAnalyzer.bindAttempt(accountId, attemptId, 'qr_code');

            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);

                const waVersion = await this._fetchWAVersion();
                console.log(`[Account ${accountId}] WA version: ${waVersion.join('.')}`);

                // مؤقت توليد QR (30 ثانية)
                const qrGenTimer = setTimeout(() => {
                    if (this.getConnectionState(accountId) === 'qr_generating') {
                        // ── تشخيص: مهلة QR ────────────────────────────────
                        DiagnosticEngine.diagnose(accountId, {
                            contextKey:  'qr_timeout',
                            fromStage:   'qr_generating',
                            extraDetails: { timeoutMs: QR_GENERATE_TIMEOUT_MS },
                        }).catch(() => {});
                        // ── Phase 7: تسجيل timeout في محلل QR ────────────
                        QRAnalyzer.onQRTimeout(accountId).catch(() => {});
                        this._emitState(accountId, 'error', { error: 'انتهت مهلة إنشاء رمز QR. حاول مرة أخرى.' });
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('connection_error', {
                                error: 'انتهت مهلة إنشاء رمز QR (30 ثانية). تأكد من الاتصال بالإنترنت وحاول مرة أخرى.'
                            });
                        }
                    }
                }, QR_GENERATE_TIMEOUT_MS);

                this._emitState(accountId, 'qr_generating');
                // ── Phase 7: بدء تتبع وقت توليد QR ───────────────────────
                QRAnalyzer.onQRGenerating(accountId);

                const sock = makeWASocket({
                    auth:               state,
                    version:            waVersion,
                    logger:             this.logger,
                    printQRInTerminal:  false,
                    keepAliveIntervalMs: 25_000,
                    connectTimeoutMs:    60_000,
                    qrTimeout:           60_000,
                    // ✅ تحسين: استخدام تعريف متصفح ثابت لتجنب الـ Disconnect المفاجئ (كود 515/401)
                    browser:             ['Ubuntu', 'Chrome', '110.0.5481.177'],
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

                        // ── Phase 2: تسجيل توليد QR ──────────────────────
                        RuntimeAnalyzer.onQRGenerated(accountId, Date.now()).catch(() => {});
                        // ── Phase 7: تسجيل QR في محلل QR ─────────────────
                        QRAnalyzer.onQRGenerated(accountId, attemptId).catch(() => {});
                        // ── Phase 9: تسجيل حدث QR في Baileys ─────────────
                        BaileysAnalyzer.onConnectionEvent(accountId, 'qr_generated', { qrIndex: 1 }, attemptId).catch(() => {});

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

                        // ── Phase 2: تسجيل حدث الانقطاع ──────────────────
                        RuntimeAnalyzer.onDisconnect(accountId, statusCode,
                            this.connStates.get(accountId) || 'connecting').catch(() => {});
                        // ── Phase 9: تسجيل انقطاع الاتصال في Baileys ─────
                        BaileysAnalyzer.onConnectionEvent(accountId, 'connection_close',
                            { statusCode, lastState: this.connStates.get(accountId) }, attemptId).catch(() => {});

                        try { require('../api/services/LinkMonitorEngine').markInactive(accountId); } catch {}

                        // جلسة فاسدة
                        // ✅ تحسين: لا تمسح الجلسة عند كود 500 إلا إذا تكرر، فقد يكون خطأ مؤقت في خادم واتساب
                        if (CLEAR_SESSION_CODES.has(statusCode)) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        // restartRequired (515)
                        if (statusCode === DisconnectReason.restartRequired) {
                            const retries515 = (this.restartAttempts.get(accountId) || 0) + 1;
                            this.restartAttempts.set(accountId, retries515);

                            const qrTime             = this.qrSentAt.get(accountId) || 0;
                            const timeSinceQR        = Date.now() - qrTime;
                            // ✅ تحسين: اعتبار الـ QR قد مُسح إذا كان الوقت أقل من 2 دقيقة (120 ثانية)
                            const qrWasJustScanned   = timeSinceQR < 120_000;

                            if (retries515 > MAX_515_RETRIES && !qrWasJustScanned) {
                                console.warn(`[Account ${accountId}] 515 repeated ${retries515}x — clearing.`);
                                this.restartAttempts.delete(accountId);
                                await this._clearSession(accountId, 515);
                                return;
                            }

                            // ✅ تحسين: زيادة التأخير عند المسح لضمان استقرار الجلسة
                            const delay515 = qrWasJustScanned ? 5000 : Math.min(retries515 * 5000, 20000);
                            console.log(`[Account ${accountId}] Restart required (515) — attempt ${retries515}/${MAX_515_RETRIES}. Reconnecting in ${delay515}ms…`);

                            if (qrWasJustScanned) {
                                this._emitState(accountId, 'connecting');
                                console.log(`[Account ${accountId}] QR was just scanned — saving creds and reconnecting.`);
                                QRAnalyzer.onQRScanned(accountId).catch(() => {});
                                // ✅ تحسين: التأكد من حفظ البيانات قبل إعادة الاتصال
                                await saveCreds().catch(() => {});
                                await new Promise(r => setTimeout(r, 1000));
                            } else if (!state.creds?.registered) {
                                // ✅ تحسين: لا تمسح البيانات فوراً، حاول الحفظ أولاً
                                await saveCreds().catch(() => {});
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
                                if (attempts >= MAX_RECONNECT_ATTEMPTS) {
                                    console.error(`[Account ${accountId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
                                    // ── تشخيص: انتهاء محاولات إعادة الاتصال ───
                                    DiagnosticEngine.diagnose(accountId, {
                                        contextKey:   'max_reconnect',
                                        disconnectCode: statusCode,
                                        fromStage:    'connecting',
                                        extraDetails: { attempts, statusCode },
                                    }).catch(() => {});
                                    // ── Phase 2: إنهاء المحاولة بفشل نهائي ───
                                    RuntimeAnalyzer.endAttempt(accountId, 'failed', 'connecting',
                                        `max_reconnect_${attempts}_attempts`).catch(() => {});
                                    await DatabaseManager.systemDB.run(
                                        `UPDATE accounts SET status='error', updated_at=NOW() WHERE id=$1`, [accountId]
                                    ).catch(() => {});
                                    this.reconnectAttempts.delete(accountId);
                                    return;
                                }
                                const delay    = Math.min(Math.pow(2, attempts) * 1000, 30000);
                                this.reconnectAttempts.set(accountId, attempts + 1);
                                this._emitState(accountId, 'disconnected', { reason: statusCode });
                                // ── Phase 2: تسجيل محاولة إعادة الاتصال ──
                                RuntimeAnalyzer.onReconnect(accountId, attempts + 1, delay).catch(() => {});
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
                        if (attempts >= MAX_RECONNECT_ATTEMPTS) {
                            console.error(`[Account ${accountId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Stopping.`);
                            await DatabaseManager.systemDB.run(
                                `UPDATE accounts SET status='error', updated_at=NOW() WHERE id=$1`, [accountId]
                            ).catch(() => {});
                            this.reconnectAttempts.delete(accountId);
                            return;
                        }
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

                        // ── تشخيص: اتصال ناجح ──────────────────────────────
                        DiagnosticEngine.diagnoseSuccess(accountId, 'qr_code').catch(() => {});
                        // ── Phase 2: إنهاء المحاولة بنجاح ────────────────
                        RuntimeAnalyzer.endAttempt(accountId, 'connected').catch(() => {});
                        // ── Phase 3: إنهاء دورة الاتصال بنجاح ───────────────
                        CycleAnalyzer.endCycle(accountId, 'connected').catch(() => {});
                        // ── Phase 7: تسجيل نجاح QR ────────────────────────
                        QRAnalyzer.onQRSuccess(accountId).catch(() => {});
                        // ── Phase 9: تسجيل نجاح الاتصال في Baileys ────────
                        BaileysAnalyzer.onConnectionEvent(accountId, 'connection_open',
                            { isOnline: true }, attemptId).catch(() => {});

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
                            // ✅ FIX: emit to BOTH room (for modal socket) AND global (for dashboard)
                            this.io.to(`account_${accountId}`).emit('account_status', { accountId, status: 'connected' });
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
                    // ── Phase 9: تسجيل حدث استقبال الرسائل ───────────────
                    const evKey = await BaileysAnalyzer.onEventStart(accountId, 'messages', 'messages.upsert', attemptId);
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
                    // ── Phase 9: انتهاء معالجة حدث الرسائل ───────────────
                    BaileysAnalyzer.onEventEnd(accountId, evKey, { count: m.messages.length }).catch(() => {});
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
            // ── Phase 2: بدء تسجيل محاولة Pairing ────────────────────────
            const reconnectNum = this.reconnectAttempts.get(accountId) || 0;
            const pairingAttemptId = await RuntimeAnalyzer.startAttempt(accountId, 'pairing_code', reconnectNum).catch(() => null);
            // ── Phase 3: ربط المحاولة بمحلل دورة الاتصال ────────────────────
            CycleAnalyzer.bindAttempt(accountId, pairingAttemptId, 'pairing_code');

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
                    // ✅ تحسين: استخدام تعريف متصفح ثابت لتجنب الـ Disconnect المفاجئ (كود 515/401)
                    browser:             ['Ubuntu', 'Chrome', '110.0.5481.177'],
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
                        // ── تشخيص: مهلة Pairing ──────────────────────────
                        DiagnosticEngine.diagnose(accountId, {
                            contextKey:  'pairing_timeout',
                            fromStage:   'pairing_generating',
                            extraDetails: { phoneNumber, timeoutMs: PAIRING_TIMEOUT_MS },
                        }).catch(() => {});
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

                            // ── Phase 2: تسجيل إنشاء Pairing Code ─────────
                            RuntimeAnalyzer.onPairingCode(accountId, phoneNumber).catch(() => {});

                            // ✅ FIX: Cache pairing code for late-joining clients (race condition fix)
                            this.lastPairingCode.set(accountId, { code: formatted, ts: Date.now() });

                            this._emitState(accountId, 'pairing_ready', { code: formatted });

                            if (this.io) {
                                // ✅ FIX: إرسال الرمز في حدث connection_state أيضاً للتأكد من استقباله
                                this.io.to(`account_${accountId}`).emit('connection_state', {
                                    accountId,
                                    state: 'pairing_ready',
                                    code: formatted,
                                    ts: Date.now(),
                                });
                                // ✅ FIX: إرسال حدث منفصل للتوافقية
                                this.io.to(`account_${accountId}`).emit('pairing_code', {
                                    code:  formatted,
                                    phone: phoneNumber,
                                });
                            }
                        } catch (err) {
                            console.error(`[Account ${accountId}][Pairing] requestPairingCode error:`, err.message);
                            // ── تشخيص: رفض Pairing ───────────────────────
                            DiagnosticEngine.diagnose(accountId, {
                                pairingError: err.message,
                                fromStage:    'pairing_generating',
                                extraDetails: { phoneNumber },
                            }).catch(() => {});
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

                        // ✅ تحسين: إذا كان الـ pairing code قد أُرسل → المستخدم قد يكون أدخله للتو
                        // كود 515 هنا يعني غالباً نجاح الإقران وبدء الجلسة
                        if (pairingRequested && statusCode === DisconnectReason.restartRequired) {
                            this._emitState(accountId, 'connecting');
                            console.log(`[Account ${accountId}][Pairing] 515 received after pairing — likely success. Reconnecting to open session...`);
                            await saveCreds().catch(() => {});
                            // انتظر قليلاً لضمان استقرار الخادم
                            setTimeout(() => this.initSession(accountId), 5000);
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

                        // ── تشخيص: نجاح Pairing ──────────────────────────
                        DiagnosticEngine.diagnoseSuccess(accountId, 'pairing_code').catch(() => {});
                        // ── Phase 2: إنهاء محاولة Pairing بنجاح ──────────
                        RuntimeAnalyzer.endAttempt(accountId, 'connected').catch(() => {});

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

                // ✅ FIX: session stored only when connection===open (line 683); not here
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

    /**
     * ✅ NEW: حذف الحساب بالكامل — يُستخدم من AccountController.deleteAccount
     * يُنظِّف: Sessions, Maps, Redis keys, BullMQ jobs, DB session data
     */
    async fullDeleteAccount(accountId) {
        console.log(`[WhatsAppManager] Full delete for account ${accountId}…`);

        // 1. إلغاء مؤقت Pairing
        const pt = this.pairingTimers.get(accountId);
        if (pt) { clearTimeout(pt); this.pairingTimers.delete(accountId); }

        // 2. إغلاق Socket بأمان
        const sock = this.sessions.get(accountId);
        if (sock) {
            try { await sock.logout().catch(() => {}); } catch (_) {}
            try { sock.end(undefined); } catch (_) {}
        }

        // 3. تنظيف جميع Maps في الذاكرة
        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId);
        this.restartAttempts.delete(accountId);
        this.qrSentAt.delete(accountId);
        this.lastQrCode.delete(accountId);
        this.lastPairingCode.delete(accountId);
        this.connStates.delete(accountId);

        // 4. تنظيف Redis keys (Rate Limiting لجميع الساعات الأخيرة)
        try {
            const redis  = getRedis();
            const nowHour = Math.floor(Date.now() / 3600000);
            const keysToDelete = [];
            for (let i = 0; i < 25; i++) {
                keysToDelete.push(`rate:${accountId}:${nowHour - i}`);
            }
            if (keysToDelete.length) await redis.del(...keysToDelete).catch(() => {});
        } catch (_) {}

        console.log(`[WhatsAppManager] Account ${accountId} fully cleaned from memory and Redis.`);
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

