'use strict';
/**
 * WhatsAppManager.js — Phase 1 + Phase 2 + Phase 3 Applied:
 *
 * ─── Phase 1 ───────────────────────────────────────────────────────────────
 * [FIX-1] Session Memory Leak:
 *   - إضافة reconnectTimers Map لتتبع setTimeout handles ومنع Ghost Timers.
 *   - تنظيف شامل لجميع Maps في _cleanupAccount().
 *   - إلغاء جميع الـ timers عند disconnectAccount() و fullDeleteAccount().
 *
 * [FIX-2] SocketBridge Integration:
 *   - استبدال this.io.emit() المباشر بـ SocketBridge للمركزية.
 *   - تبقى this.io كـ fallback للتوافق مع الكود القائم.
 *
 * [FIX-3] Race Condition Prevention:
 *   - _emitState() يُرسل عبر SocketBridge الذي يدعم replay للـ late-joiners.
 *   - QR و PairingCode مُخزَّنان مع timestamp للـ replay.
 *
 * ─── Phase 3 ───────────────────────────────────────────────────────────────
 * [FIX-9]  StateMachine:
 *   - FSM واضح: idle→initializing→qr_generating→qr_ready→connecting→connected
 *   - منع الانتقالات غير الصالحة مع تسجيل تحذير واضح.
 *   - _setState() يستدعي FSM ثم يُرسل عبر SocketBridge.
 *
 * [FIX-10] AutoRecoveryEngine:
 *   - Exponential Backoff مع Jitter لتجنب thundering herd.
 *   - تفريق بين auth_failure (يحتاج QR) و network_error (يُعيد المحاولة).
 *   - حد أقصى للمحاولات مع تسجيل واضح.
 *
 * [FIX-11] EventBus:
 *   - أحداث مركزية: account:connected, account:disconnected, account:qr_ready...
 *   - WhatsAppManager يُصدر الأحداث دون استدعاء مباشر للـ modules الأخرى.
 *
 * [FIX-12] SessionPersistence:
 *   - حفظ metadata الجلسة في Redis عند الاتصال.
 *   - استرجاعها عند restart بدلاً من بدء QR من الصفر.
 */
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
// [FIX-2] SocketBridge — Global Socket Layer
const SocketBridge = require('../core/SocketBridge');

// ─── Phase 3 Imports ──────────────────────────────────────────────────────────
// [FIX-9]  StateMachine — FSM لحالات الاتصال
const StateMachine = require('../core/StateMachine');
// [FIX-10] AutoRecoveryEngine — إعادة الاتصال الذكي مع Exponential Backoff
const AutoRecovery = require('../core/AutoRecoveryEngine');
// [FIX-11] EventBus — أحداث مركزية بين الـ modules
const EventBus = require('../core/EventBus');
// [FIX-12] SessionPersistence — حفظ حالة الجلسة في Redis
const SessionPersistence = require('../core/SessionPersistence');

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

const QR_SCAN_WINDOW_MS      = 180_000; // 3 دقائق — وقت كافٍ بعد المسح للاتصال
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
        // [FIX-1] SESSION MEMORY LEAK: تتبع جميع setTimeout handles لمنع Ghost Timers
        this.reconnectTimers   = new Map(); // accountId → NodeJS.Timeout
        // [FIX-QR-RACE] تتبع ما بعد مسح QR لمنع إعادة توليد QR قبل اكتمال التسجيل
        // السبب: creds.registered يصبح true فقط بعد connection:open، ليس بعد مسح QR
        // لذا إذا استدعينا initSession مرة أخرى بعد 515 (post-QR-scan)، يُولِّد QR جديداً
        this.postScanReconnect = new Set(); // accountId — مسح QR، في انتظار open
        this.io                = null;
        this.logger            = pino({ level: 'silent' });
    }

    /**
     * [FIX-2] setIO — يُهيِّئ Socket.IO في WhatsAppManager وSocketBridge معاً.
     * يُستدعى مرة واحدة من index.js بعد إنشاء Server.
     */
    setIO(io) {
        this.io = io;
        // SocketBridge يتلقى io هنا فقط إذا لم يكن مُهيَّأً بعد
        if (!SocketBridge.isReady) {
            SocketBridge.init(io);
        }
    }

    /**
     * [FIX-1] _cancelReconnectTimer — يُلغي مؤقت إعادة الاتصال إن وُجد.
     * يمنع Ghost Timers التي تُسبِّب Memory Leaks.
     */
    _cancelReconnectTimer(accountId) {
        const timer = this.reconnectTimers.get(accountId);
        if (timer) {
            clearTimeout(timer);
            this.reconnectTimers.delete(accountId);
        }
    }

    /**
     * [FIX-1] _scheduleReconnect — يُجدوِل إعادة الاتصال مع تتبع الـ timer.
     * يضمن أنه لا يوجد أكثر من مؤقت واحد لكل حساب في أي وقت.
     */
    _scheduleReconnect(accountId, delayMs, fn) {
        this._cancelReconnectTimer(accountId); // إلغاء أي مؤقت سابق أولاً
        const timer = setTimeout(() => {
            this.reconnectTimers.delete(accountId);
            fn();
        }, delayMs);
        this.reconnectTimers.set(accountId, timer);
        return timer;
    }

    /**
     * [FIX-1][FIX-10] _cleanupAccount — تنظيف شامل لجميع Maps لحساب معين.
     * يُستدعى من _clearSession و fullDeleteAccount.
     */
    _cleanupAccount(accountId) {
        // إلغاء جميع الـ timers أولاً
        this._cancelReconnectTimer(accountId);
        // [FIX-10] إلغاء AutoRecovery timer
        AutoRecovery.cancel(accountId);
        const pt = this.pairingTimers.get(accountId);
        if (pt) { clearTimeout(pt); this.pairingTimers.delete(accountId); }

        // إغلاق الـ socket
        const sock = this.sessions.get(accountId);
        if (sock) { try { sock.end(undefined); } catch (_) {} }

        // تنظيف جميع Maps
        this.sessions.delete(accountId);
        this.initPromises.delete(accountId);
        this.reconnectAttempts.delete(accountId);
        this.restartAttempts.delete(accountId);
        this.qrSentAt.delete(accountId);
        this.lastQrCode.delete(accountId);
        this.lastPairingCode.delete(accountId);
        this.connStates.delete(accountId);
        this.reconnectTimers.delete(accountId);
        // [FIX-QR-RACE] تنظيف علامة ما بعد المسح
        this.postScanReconnect.delete(accountId);

        // [FIX-9] تنظيف FSM
        StateMachine.cleanup(accountId);
        // [FIX-10] تنظيف AutoRecovery
        AutoRecovery.reset(accountId);
    }

    // ── Emit connection state change ─────────────────────────────────────────
    /**
     * [FIX-9][FIX-11][FIX-12] _setState — الإصدار المحدَّث:
     *  1. ينتقل عبر StateMachine (FSM) مع التحقق من صحة الانتقال
     *  2. يُصدر أحداث EventBus المناسبة
     *  3. يحفظ/يُحدِّث SessionPersistence في Redis
     *  4. يُرسل عبر SocketBridge للـ clients
     */
    _setState(accountId, newState, extra = {}) {
        // [FIX-9] تهيئة FSM لأول مرة إن لزم
        StateMachine.init(accountId);
        const prevState = StateMachine.getState(accountId);

        // محاولة الانتقال عبر FSM
        const ok = StateMachine.transition(accountId, newState, extra);
        if (!ok) {
            // [FIX-FORCE] توسيع forceAllowed: جميع حالات البدء يجب أن لا تُحجب بصمت
            // pairing_starting و qr_generating يجب أن تُنفَّذ دائماً حتى لو FSM يرفضها
            const forceAllowed = [
                'error', 'disconnected', 'initializing', 'idle',
                'pairing_starting', 'pairing_generating', 'qr_generating',
            ];
            if (forceAllowed.includes(newState)) {
                StateMachine.forceTransition(accountId, newState, extra);
            } else {
                // انتقال غير صالح — تجاهل بصمت (تحذير مسجَّل بالفعل داخل FSM)
                return;
            }
        }

        // تحديث connStates للتوافق مع الكود القائم
        this.connStates.set(accountId, newState);

        // [FIX-11] أحداث EventBus حسب الحالة الجديدة
        switch (newState) {
            case 'connected':
                EventBus.emitConnected(accountId, extra.phone || null);
                SessionPersistence.saveSession(accountId, extra).catch(() => {}); // [FIX-12]
                break;
            case 'disconnected':
                EventBus.emitDisconnected(accountId, extra.reason || 'unknown', extra.code || null);
                SessionPersistence.markDisconnected(accountId).catch(() => {}); // [FIX-12]
                break;
            case 'qr_ready':
                if (extra.qr) EventBus.emitQRReady(accountId, extra.qr);
                break;
            case 'pairing_ready':
                if (extra.code) EventBus.emitPairingReady(accountId, extra.code);
                break;
            case 'error':
                EventBus.emitError(accountId, extra.error || 'unknown error');
                break;
            default:
                break;
        }

        // Analyzers (Phase 2 — نفس المنطق القديم)
        DiagnosticEngine.trackStage(accountId, newState, extra);
        RuntimeAnalyzer.onStateChange(accountId, newState, extra).catch(() => {});
        CycleAnalyzer.onStageChange(accountId, newState, extra).catch(() => {});

        // [FIX-2] SocketBridge — إرسال مركزي (مصدر وحيد للحقيقة)
        // ⚠️ BUG #1 FIX: تمت إزالة io.to().emit() المباشر هنا لمنع إرسال connection_state مرتين
        // SocketBridge.emitConnectionState يغطي الغرفة بالكامل — لا حاجة لإرسال ثانٍ
        SocketBridge.emitConnectionState(accountId, newState, extra);

        console.log(`[Account ${accountId}] State ${prevState} → ${newState}`, extra.error ? `(${extra.error})` : '');
    }

    /**
     * [COMPAT] _emitState — wrapper للتوافق مع الكود القائم.
     * جميع الاستدعاءات القديمة تنتقل تلقائياً إلى _setState الجديدة.
     */
    _emitState(accountId, state, extra = {}) {
        return this._setState(accountId, state, extra);
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
        const state       = this.getConnectionState(accountId);
        const cached      = this.lastQrCode.get(accountId);
        const qr          = cached && (Date.now() - cached.ts < QR_CACHE_TTL_MS) ? cached.qr : null;
        const pairingData = this.lastPairingCode.get(accountId);
        const code        = pairingData && (Date.now() - pairingData.ts < 120_000) ? pairingData.code : null;
        return { state, qr, ts: cached?.ts || null, code };
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
        
        const result = await sock.sendMessage(to, content);
        
        // [FIX-TRACKING] تسجيل إرسال الرسالة في المحلل لضمان التتبع والتحقق
        try {
            const messageId = result?.key?.id;
            if (messageId) {
                const jid = to;
                BaileysAnalyzer.onMessageSent(accountId, messageId, jid).catch(() => {});
            }
        } catch (e) {
            console.warn(`[Account ${accountId}] Failed to log message sent:`, e.message);
        }
        
        return result;
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

        // [FIX-1] تنظيف شامل عبر _cleanupAccount (يُلغي جميع الـ timers ويُنظِّف جميع Maps)
        this._cleanupAccount(accountId);

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
        const noReconnectCodes = new Set([
            DisconnectReason.loggedOut,          // 401 — المستخدم أغلق الجلسة يدوياً
            DisconnectReason.connectionReplaced, // 440 — جلسة مفتوحة في مكان آخر
        ]);
        const shouldReconnect = !noReconnectCodes.has(code) && code !== 'force_reset';

        this._emitState(accountId, 'disconnected', { reason: 'session_cleared', code });

        // [FIX-2] استخدام SocketBridge للإرسال المركزي
        SocketBridge.emitAccountStatus(accountId, 'disconnected', { reason: 'session_cleared' });
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

        // [FIX-1] استخدام _scheduleReconnect بدلاً من setTimeout المباشر
        if (shouldReconnect) {
            console.log(`[Account ${accountId}] Will auto-reconnect in 3s…`);
            this._scheduleReconnect(accountId, 3000, () => this.initSession(accountId));
        } else {
            console.log(`[Account ${accountId}] No auto-reconnect for code ${code}.`);
        }
    }

    // ── جلب إصدار WA ─────────────────────────────────────────────────────────
    // [FIX-VERSION] إعادة المحاولة 3 مرات قبل الوقوع إلى الإصدار الاحتياطي
    async _fetchWAVersion() {
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const { version } = await fetchLatestWaWebVersion();
                return version;
            } catch (err) {
                if (attempt < 2) {
                    // انتظر قبل إعادة المحاولة (2s ثم 4s)
                    await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
                }
            }
        }
        // إصدار احتياطي — تم التحديث من الإصدار القديم [2,3000,1041235764]
        // هذا الإصدار أحدث ويُقلِّل احتمالية الرفض من خوادم واتساب
        console.warn('[WhatsAppManager] fetchLatestWaWebVersion failed 3 times — using fallback version.');
        return [2, 3000, 1023141390];
    }

    // ── Init Session (QR Code Flow) ──────────────────────────────────────────
    async initSession(accountId) {
        if (this.sessions.has(accountId))     return this.sessions.get(accountId);
        if (this.initPromises.has(accountId)) return this.initPromises.get(accountId);

        console.log(`[SOCKET_CONNECTED] Account ${accountId}: Starting new session init...`);
        this._emitState(accountId, 'initializing');

        const initPromise = (async () => {
            console.log(`[SESSION_CREATE] Account ${accountId}: Initializing QR session (reconnect=${this.reconnectAttempts.get(accountId) || 0})`);
            // ── Phase 2: بدء تسجيل محاولة الاتصال ─────────────────────────
            const reconnectNum = this.reconnectAttempts.get(accountId) || 0;
            const attemptId    = await RuntimeAnalyzer.startAttempt(accountId, 'qr_code', reconnectNum).catch(() => null);
            // ── Phase 3: ربط المحاولة بمحلل دورة الاتصال ────────────────────
            CycleAnalyzer.bindAttempt(accountId, attemptId, 'qr_code');

                    try {
            const { state, saveCreds } = await this._usePostgresAuthState(accountId);

            // ✅ إصلاح جوهري: إذا لم يكن الحساب مسجلاً (registered: false)
            // ونحن في دالة initSession العادية، فهذا يعني أننا فقدنا وضع Pairing
            // يجب إعادة التوجيه لـ initPairingSession إذا كان هناك رقم هاتف مخزن
            if (!state.creds?.registered) {
                // تصحيح: استخدام query المباشرة من lib/postgres عبر SystemDB أو استخدام queryOne المستوردة
                const { queryOne } = require('../lib/postgres');
                const account = await queryOne(
                    `SELECT phone_number, connection_type FROM accounts WHERE id = $1`, [accountId]
                );
                if (account?.connection_type === 'pairing_code' && account?.phone_number) {
                    console.log(`[Account ${accountId}] Session not registered but in pairing mode — redirecting to initPairingSession.`);
                    return this.initPairingSession(accountId, account.phone_number);
                }
            }

            const waVersion = await this._fetchWAVersion();
            console.log(`[SESSION_RESTORE] Account ${accountId}: Auth state loaded. registered=${!!state.creds?.registered}. WA version: ${waVersion.join('.')}`);

            // ✅ إصلاح جوهري: إذا كانت الكريدنشال محفوظة (registered=true) فنتخطى qr_generating
            const isRegistered = !!state.creds?.registered;

            // [FIX-QR-RACE] تحقق من علامة ما بعد المسح
            // السبب: creds.registered يصبح true فقط عند connection:open
            // لكن بعد مسح QR يرد 515 أولاً وcreds.registered لا يزال false
            // الحل: نتذكر أن المسح حدث ونتخطى QR generation في المحاولة التالية
            const isPostScan = this.postScanReconnect.has(accountId);
            if (isPostScan) {
                this.postScanReconnect.delete(accountId);
                console.log(`[Account ${accountId}] Post-scan reconnect — skipping QR generation, trying to complete auth.`);
            }

            if (isRegistered || isPostScan) {
                this._emitState(accountId, 'connecting');
                if (!isRegistered) {
                    console.log(`[Account ${accountId}] QR scanned — creds not registered yet but resuming auth with scanned keys.`);
                } else {
                    console.log(`[Account ${accountId}] Creds registered — skipping QR generation, reconnecting directly.`);
                }
            } else {
                this._emitState(accountId, 'qr_generating');
                QRAnalyzer.onQRGenerating(accountId);
            }

                // مؤقت: 30 ثانية للـ QR (غير مسجل) أو 90 ثانية لإعادة الاتصال (مسجل)
                const genTimeoutMs = isRegistered ? 90_000 : QR_GENERATE_TIMEOUT_MS;
                const qrGenTimer = setTimeout(() => {
                    const curState = this.getConnectionState(accountId);
                    const shouldFire = isRegistered
                        ? (curState === 'connecting' || curState === 'initializing')
                        : curState === 'qr_generating';
                    if (shouldFire) {
                        DiagnosticEngine.diagnose(accountId, {
                            contextKey:  isRegistered ? 'reconnect_timeout' : 'qr_timeout',
                            fromStage:   curState,
                            extraDetails: { timeoutMs: genTimeoutMs, isRegistered },
                        }).catch(() => {});
                        if (!isRegistered) QRAnalyzer.onQRTimeout(accountId).catch(() => {});
                        const errMsg = isRegistered
                            ? 'انتهت مهلة إعادة الاتصال. تأكد من الإنترنت وحاول مرة أخرى.'
                            : 'انتهت مهلة إنشاء رمز QR. حاول مرة أخرى.';
                        this._emitState(accountId, 'error', { error: errMsg });
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('connection_error', { error: errMsg });
                        }
                    }
                }, genTimeoutMs);

                const sock = makeWASocket({
                    auth:               state,
                    version:            waVersion,
                    logger:             this.logger,
                    printQRInTerminal:  false,
                    keepAliveIntervalMs: 25_000,
                    connectTimeoutMs:    60_000,
                    qrTimeout:           60_000,
                    // ✅ تحسين: استخدام تعريف متصفح ثابت لتجنب الـ Disconnect المفاجئ (كود 515/401)
                    // ✅ تحسين: استخدام macOS Chrome لتجنب رفض واتساب لبعض البيئات
                    browser:             Browsers.macOS('Chrome'),
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
                        const qrTs = Date.now();
                        console.log(`[QR_GENERATED] Account ${accountId}: QR Code ready.`);
                        this.qrSentAt.set(accountId, qrTs);
                        this.restartAttempts.delete(accountId);
                        this.lastQrCode.set(accountId, { qr, ts: qrTs });

                        // ── Phase 2: تسجيل توليد QR ──────────────────────
                        RuntimeAnalyzer.onQRGenerated(accountId, qrTs).catch(() => {});
                        // ── Phase 7: تسجيل QR في محلل QR ─────────────────
                        QRAnalyzer.onQRGenerated(accountId, attemptId).catch(() => {});
                        // ── Phase 9: تسجيل حدث QR في Baileys ─────────────
                        BaileysAnalyzer.onConnectionEvent(accountId, 'qr_generated', { qrIndex: 1 }, attemptId).catch(() => {});

                        // [FIX-QR-PAYLOAD] تضمين QR في extra لضمان وصوله عبر SocketBridge و EventBus
                        this._emitState(accountId, 'qr_ready', { qr });

                        // [FIX-QR-DUAL] إرسال QR عبر حدث منفصل للتوافقية الكاملة
                        // ⚠️ BUG #2 FIX: SocketBridge.emitQR() أُزيل — _emitState يُرسل connection_state مع qr
                        // و SocketBridge._replayState يتولى الـ late-joiners تلقائياً
                        if (this.io) {
                            this.io.to(`account_${accountId}`).emit('qr_code', { qr, ts: qrTs });
                        }
                        console.log(`[QR_SENT_TO_FRONTEND] Account ${accountId}: QR emitted to room account_${accountId}`);
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

                        // ═══════════════════════════════════════════════════════════
                        // [ROOT FIX-500] إصلاح جذري: "QR يظهر لكن الربط لا يكتمل"
                        //
                        // المشكلة: بعض إصدارات بروتوكول واتساب ترسل كود 500 (badSession)
                        // فوراً بعد مسح المستخدم لـ QR، بدلاً من 515 (restartRequired)
                        // المتوقَّع. الكود القديم كان يمسح الجلسة فوراً عند 500 (سطر
                        // CLEAR_SESSION_CODES أدناه) دون فحص "هل تم المسح للتو؟" — وهذا
                        // الفحص موجود فقط في مسار 515. النتيجة: المستخدم يمسح QR، الجلسة
                        // تُحذف فوراً قبل اكتمال التسجيل، فيُطلب منه QR جديد إلى ما لا نهاية
                        // أو ينقطع الاتصال بصمت دون أي رسالة واضحة.
                        //
                        // الحل: نطبّق نفس منطق qrWasJustScanned المستخدم في معالجة 515
                        // على كود 500 تحديداً (لا على 401/440 لأنهما تسجيل خروج صريح من
                        // واتساب ولا ينبغي تجاوزهما أبداً).
                        // ═══════════════════════════════════════════════════════════
                        if (statusCode === DisconnectReason.badSession) {
                            const qrTime500      = this.qrSentAt.get(accountId) || 0;
                            const justScanned500 = (Date.now() - qrTime500) < 120_000;

                            if (justScanned500) {
                                const retries500 = (this.restartAttempts.get(accountId) || 0) + 1;
                                this.restartAttempts.set(accountId, retries500);

                                if (retries500 > MAX_515_RETRIES) {
                                    console.warn(`[Account ${accountId}] badSession(500) repeated ${retries500}x after scan — clearing for real.`);
                                    this.restartAttempts.delete(accountId);
                                    await this._clearSession(accountId, 500);
                                    return;
                                }

                                console.log(`[Account ${accountId}] badSession(500) right after QR scan — treating like 515, NOT clearing session (attempt ${retries500}/${MAX_515_RETRIES}).`);
                                this._emitState(accountId, 'connecting');
                                QRAnalyzer.onQRScanned(accountId).catch(() => {});

                                if (state.creds) {
                                    state.creds.registered = true;
                                    console.log(`[Account ${accountId}] creds.registered forced to true (500-after-scan path).`);
                                }
                                await saveCreds().catch(() => {});
                                await new Promise(r => setTimeout(r, 2000));
                                this.postScanReconnect.add(accountId);

                                this._scheduleReconnect(accountId, 8000, () => this.initSession(accountId));
                                return;
                            }
                            // لم يُمسَح QR حديثاً → جلسة فاسدة فعلياً، تابع للمسح أدناه
                        }

                        // جلسة فاسدة (401 تسجيل خروج صريح / 440 جلسة مفتوحة بمكان آخر /
                        // 500 بدون مسح حديث لـ QR)
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
                            // delay515=8s بعد المسح لإعطاء WA server وقتاً لمعالجة التسجيل
                            const delay515 = qrWasJustScanned ? 8000 : Math.min(retries515 * 5000, 20000);
                            console.log(`[RECONNECT_START] Account ${accountId}: 515 restart required — attempt ${retries515}/${MAX_515_RETRIES}. Reconnecting in ${delay515}ms…`);

                            if (qrWasJustScanned) {
                                this._emitState(accountId, 'connecting');
                                console.log(`[Account ${accountId}] QR was just scanned — forcing registered=true and saving creds.`);
                                QRAnalyzer.onQRScanned(accountId).catch(() => {});

                                // ═══════════════════════════════════════════════════════════
                                // [ROOT FIX] الإصلاح الجذري لمشكلة "تعذر تسجيل الدخول":
                                //
                                // المشكلة: creds.registered يبقى false حتى connection:open
                                // لكن 515 يفور قبل connection:open
                                // → initSession التالية ترى registered=false → تولّد QR جديد
                                // → Baileys يبدأ تسجيلاً جديداً يتعارض مع بيانات المسح
                                // → WhatsApp: "تعذر تسجيل الدخول"
                                //
                                // الحل: نضع registered=true يدوياً قبل الحفظ
                                // → initSession التالية ترى registered=true
                                // → Baileys يُكمل Auth بالـ keys المخزنة (من مسح QR)
                                // → connection:open يفور بنجاح ✅
                                // ═══════════════════════════════════════════════════════════
                                if (state.creds) {
                                    state.creds.registered = true;
                                    console.log(`[Account ${accountId}] creds.registered forced to true — Baileys will resume session instead of new QR.`);
                                }
                                await saveCreds().catch(() => {});
                                await new Promise(r => setTimeout(r, 2000));
                                // [FIX-QR-RACE] علامة إضافية للأمان
                                this.postScanReconnect.add(accountId);
                                console.log(`[Account ${accountId}] postScanReconnect flag set — next initSession will skip QR.`);
                            } else if (!state.creds?.registered) {
                                // ✅ تحسين: لا تمسح البيانات فوراً، حاول الحفظ أولاً
                                await saveCreds().catch(() => {});
                            } else {
                                await saveCreds().catch(() => {});
                            }

                            // [FIX-1] _scheduleReconnect يمنع Ghost Timers
                            this._scheduleReconnect(accountId, delay515, () => this.initSession(accountId));
                            return;
                        }

                        // انقطاع مؤقت (408 / 428)
                        if (TEMP_DISCONNECT_CODES.has(statusCode)) {
                            const lastQR  = this.qrSentAt.get(accountId) || 0;
                            const elapsed = Date.now() - lastQR;

                            if (elapsed < QR_SCAN_WINDOW_MS) {
                                // QR لا يزال نافذاً — انتظر نهاية نافذة المسح
                                const remaining = QR_SCAN_WINDOW_MS - elapsed + 2000;
                                this._emitState(accountId, 'connecting');
                                console.log(`[Account ${accountId}] QR pending — waiting ${remaining}ms before reconnect.`);
                                this._scheduleReconnect(accountId, remaining, () => this.initSession(accountId));
                            } else {
                                // [FIX-10] AutoRecoveryEngine يتولى جدولة إعادة الاتصال
                                this._emitState(accountId, 'disconnected', { reason: statusCode });
                                const result = AutoRecovery.scheduleReconnect(
                                    accountId,
                                    () => this.initSession(accountId),
                                    { disconnectCode: statusCode }
                                );
                                if (!result.scheduled) {
                                    // انتهت المحاولات
                                    DiagnosticEngine.diagnose(accountId, {
                                        contextKey: 'max_reconnect', disconnectCode: statusCode,
                                        fromStage: 'connecting', extraDetails: { statusCode },
                                    }).catch(() => {});
                                    RuntimeAnalyzer.endAttempt(accountId, 'failed', 'connecting',
                                        `max_reconnect_reached`).catch(() => {});
                                    await DatabaseManager.systemDB.run(
                                        `UPDATE accounts SET status='error', updated_at=NOW() WHERE id=$1`, [accountId]
                                    ).catch(() => {});
                                } else {
                                    RuntimeAnalyzer.onReconnect(accountId, result.attempt, result.delay).catch(() => {});
                                }
                            }

                            SocketBridge.emitAccountStatus(accountId, 'disconnected', { reason: statusCode });
                            if (this.io) {
                                this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                            }
                            return;
                        }

                        // أي كود آخر — [FIX-10] AutoRecoveryEngine
                        this._emitState(accountId, 'disconnected', { reason: statusCode });
                        SocketBridge.emitAccountStatus(accountId, 'disconnected', { reason: statusCode });
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'disconnected', reason: statusCode });
                        }
                        const result = AutoRecovery.scheduleReconnect(
                            accountId,
                            () => this.initSession(accountId),
                            { disconnectCode: statusCode }
                        );
                        if (!result.scheduled) {
                            await DatabaseManager.systemDB.run(
                                `UPDATE accounts SET status='error', updated_at=NOW() WHERE id=$1`, [accountId]
                            ).catch(() => {});
                        }
                    }

                    // ── اتصال ناجح ────────────────────────────────────────────
                    if (connection === 'open') {
                        clearTimeout(qrGenTimer);
                        console.log(`[AUTH_SUCCESS] Account ${accountId}: QR scan completed — connection open.`);
                        console.log(`[QR_SCANNED] Account ${accountId}: QR was scanned and accepted by WhatsApp.`);
                        this.reconnectAttempts.delete(accountId);
                        this.restartAttempts.delete(accountId);
                        this.qrSentAt.delete(accountId);
                        this.lastQrCode.delete(accountId);

                        // [FIX-10] AutoRecoveryEngine: إعادة تعيين عداد المحاولات عند النجاح
                        AutoRecovery.onSuccess(accountId);

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

                        // [FIX-IMMEDIATE] تحديث حالة الاتصال فوراً في قاعدة البيانات قبل إرسال الحالة للواجهة
                        await DatabaseManager.systemDB.run(
                            `UPDATE accounts SET status = 'connected', health_status = 'normal', updated_at = NOW() WHERE id = $1`,
                            [accountId]
                        ).catch(err => console.error(`[Account ${accountId}] Failed to update DB status to connected:`, err));

                        this._emitState(accountId, 'connected');

                        try {
                            const LinkMonitorEngine = require('../api/services/LinkMonitorEngine');
                            LinkMonitorEngine.markActive(accountId);
                        } catch {}

                        // ⚠️ BUG #4 FIX: استخدام SocketBridge بدلاً من io.emit المباشر
                        // SocketBridge.emitAccountStatus يُرسل للغرفة + البث العام في آنٍ واحد
                        // يمنع التكرار الناتج عن io.to().emit() + io.emit() في نفس الوقت
                        SocketBridge.emitAccountStatus(accountId, 'connected');
                        SocketBridge.emitNotification('success', '✅ تم الاتصال', 'تم ربط حساب الواتساب بنجاح.', accountId);
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
                // [FIX-1] _scheduleReconnect يمنع Ghost Timers
                this._scheduleReconnect(accountId, delay, () => this.initSession(accountId));
                return null;
            } finally {
                this.initPromises.delete(accountId);
            }
        })();

        this.initPromises.set(accountId, initPromise);
        return await initPromise;
    }

    getSession(accountId) { return this.sessions.get(accountId); }

    /**
     * [FIX-DUPLICATE-CONNECT] isConnecting — هل هناك عملية اتصال/ربط جارية لهذا الحساب؟
     * يُستخدم من AccountController لمنع تكرار طلبات /connect أو /connect-pairing
     * (مثل ضغط المستخدم على الزر مرتين بسرعة)، والذي كان يُنشئ socketين متنافسين
     * على نفس بيانات Baileys ويُسبِّب حلقات قطع اتصال 515/500 لا تنتهي.
     */
    isConnecting(accountId) {
        if (this.initPromises.has(accountId)) return true;
        const state = this.getConnectionState(accountId);
        return ['initializing', 'qr_generating', 'qr_ready', 'scanning',
                'pairing_starting', 'pairing_generating', 'pairing_ready',
                'connecting'].includes(state);
    }

    // [NOTE] startFreshQRSession is defined later in this file (see [FIX-QR] section)

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
    async initPairingSession(accountId, rawPhoneNumber) {
        // ✅ تنظيف رقم الهاتف: إزالة أي رموز غير رقمية لضمان قبول واتساب للرقم
        let phoneNumber = rawPhoneNumber.replace(/\D/g, '');
        
        // [FIX-PHONE-FORMAT] التأكد من أن الرقم لا يبدأ بـ 00 أو + (تمت إزالتها بالفعل بـ \D)
        // ولكن يجب التأكد من عدم وجود صفر دولي بادئ إذا كان متبوعاً برمز الدولة
        if (phoneNumber.startsWith('00')) phoneNumber = phoneNumber.substring(2);

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

        // [FIX-PAIRING-FSM] تنظيف FSM قبل البدء
        // السبب: إذا كان الحساب في حالة qr_ready/qr_generating (بعد محاولة QR فاشلة)،
        // فإن انتقال FSM إلى pairing_starting سيُحجَب وتبقى الواجهة معلقة.
        // الحل: نُعيد تهيئة FSM دائماً عند بدء جلسة Pairing جديدة.
        StateMachine.cleanup(accountId);

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
                    // ✅ تحسين: استخدام macOS Chrome لتجنب رفض واتساب لبعض البيئات
                    browser:             Browsers.macOS('Chrome'),
                    syncFullHistory:     false,
                    markOnlineOnConnect: false,
                    retryRequestDelayMs: 500,
                    maxRetries:          5,
                });

                sock.ev.on('creds.update', saveCreds);

                // [FIX-SESSION-TRACK] تسجيل الـ socket فوراً عند إنشائه، لا فقط عند open.
                // السبب: قبل هذا الإصلاح كان this.sessions لا يحتوي على socket الـ Pairing
                // أثناء pairing_generating/pairing_ready، فلا يستطيع _cleanupAccount أو أي
                // محاولة اتصال أخرى لنفس الحساب إيجاده وإغلاقه، مما يسمح بوجود
                // اتصالين (sockets) متنافسين على نفس بيانات Baileys ويُسبِّب حلقات 515/500.
                this.sessions.set(accountId, sock);

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
                        console.log(`[PAIRING_START] Account ${accountId}: QR event intercepted — requesting pairing code for ${phoneNumber}`);

                        try {
                            console.log(`[PAIRING_REQUESTED] Account ${accountId}: calling requestPairingCode(${phoneNumber})`);
                            const code      = await sock.requestPairingCode(phoneNumber);
                            const formatted = code?.match(/.{1,4}/g)?.join('-') || code;

                            console.log(`[PAIRING_CODE_RECEIVED] Account ${accountId}: code = ${formatted}`);

                            // ── Phase 2: تسجيل إنشاء Pairing Code ─────────
                            RuntimeAnalyzer.onPairingCode(accountId, phoneNumber).catch(() => {});

                            // ✅ FIX: Cache pairing code for late-joining clients (race condition fix)
                            this.lastPairingCode.set(accountId, { code: formatted, ts: Date.now() });

                            this._emitState(accountId, 'pairing_ready', { code: formatted });
                            console.log(`[PAIRING_CODE_SENT] Account ${accountId}: code ${formatted} sent to frontend`);

                            // ⚠️ BUG #5 FIX: إزالة إرسال connection_state المُكرَّر
                            // _emitState أعلاه يُرسل بالفعل connection_state (مع code) عبر SocketBridge
                            // نُبقي على pairing_code كحدث منفصل للتوافقية فقط (بدون connection_state مُكرَّر)
                            if (this.io) {
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
                        // ═══════════════════════════════════════════════════════════
                        // [ROOT FIX-500-PAIRING] نفس إصلاح ROOT FIX-500 (مسار QR) لكن هنا
                        // نعتمد على pairingRequested بدل qrSentAt: إذا كان الكود قد أُرسل
                        // للمستخدم بالفعل، فكود 500 (badSession) المفاجئ يُعامَل كـ515 —
                        // لا نمسح الجلسة، بل نُكمل الاتصال بنفس بيانات المصادقة.
                        // ═══════════════════════════════════════════════════════════
                        if (statusCode === DisconnectReason.badSession && pairingRequested) {
                            const retries500p = (this.restartAttempts.get(accountId) || 0) + 1;
                            this.restartAttempts.set(accountId, retries500p);

                            if (retries500p > MAX_515_RETRIES) {
                                console.warn(`[Account ${accountId}][Pairing] badSession(500) repeated ${retries500p}x after code entry — clearing for real.`);
                                this.restartAttempts.delete(accountId);
                                await this._clearSession(accountId, 500);
                                return;
                            }

                            console.log(`[Account ${accountId}][Pairing] badSession(500) right after code entry — treating like 515, NOT clearing session (attempt ${retries500p}/${MAX_515_RETRIES}).`);
                            this._emitState(accountId, 'connecting');

                            if (state.creds) {
                                state.creds.registered = true;
                                console.log(`[Account ${accountId}][Pairing] creds.registered forced to true (500-after-code path).`);
                            }
                            await saveCreds().catch(() => {});
                            await new Promise(r => setTimeout(r, 2000));
                            this.postScanReconnect.add(accountId);

                            this._scheduleReconnect(accountId, 8000, () => this.initSession(accountId));
                            return;
                        }

                        if (CLEAR_SESSION_CODES.has(statusCode)) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        // ✅ تحسين جوهري: معالجة كود 515 بعد طلب Pairing
                        // كود 515 (Restart Required) يحدث غالباً بعد إدخال الكود في الجوال بنجاح
                        if (statusCode === DisconnectReason.restartRequired) {
                            // [FIX-PAIRING-515] إذا كان الحساب مسجلاً → ننتقل لـ initSession
                            if (state.creds?.registered) {
                                await saveCreds().catch(() => {});
                                console.log(`[Account ${accountId}][Pairing] 515 received & registered — transitioning to full session.`);
                                this._emitState(accountId, 'connecting');
                                this._scheduleReconnect(accountId, 3000, () => this.initSession(accountId));
                            } else if (pairingRequested) {
                                // ═══════════════════════════════════════════════════════════
                                // [ROOT FIX] الإصلاح الجذري لمشكلة Pairing Code:
                                //
                                // المشكلة: الكود أُدخل في الهاتف → 515 فار → creds.registered=false
                                // → initPairingSession مجدداً → كود جديد لا علاقة له بالإدخال الأول
                                // → الحلقة اللانهائية: "بانتظار إدخال الرمز → جار إنشاء Code... → منقطع"
                                //
                                // الحل: نضع registered=true يدوياً قبل الحفظ
                                // → initSession التالية ترى registered=true
                                // → Baileys يُكمل Auth بالـ keys المخزنة (من إدخال الكود)
                                // → connection:open يفور بنجاح ✅
                                // ═══════════════════════════════════════════════════════════
                                console.log(`[Account ${accountId}][Pairing] 515 after code entry — forcing registered=true.`);
                                if (state.creds) {
                                    state.creds.registered = true;
                                    console.log(`[Account ${accountId}][Pairing] creds.registered forced to true — Baileys will resume session.`);
                                }
                                await saveCreds().catch(() => {});
                                await new Promise(r => setTimeout(r, 2000));
                                this.postScanReconnect.add(accountId);
                                this._emitState(accountId, 'connecting');
                                this._scheduleReconnect(accountId, 5000, () => this.initSession(accountId));
                            } else {
                                // الكود لم يُدخل بعد → نعيد محاولة Pairing
                                await saveCreds().catch(() => {});
                                console.log(`[Account ${accountId}][Pairing] 515 received but code NOT entered yet — retrying pairing.`);
                                this._scheduleReconnect(accountId, 3000, () => this.initPairingSession(accountId, phoneNumber));
                            }
                            return;
                        }

                        // ────────────────────────────────────────────────────────────────
                        // [FIX-PAIRING-408] انقطاع شبكة — التفريق بين حالتين:
                        //
                        // الحالة A: pairingRequested=true (تم إرسال الكود بالفعل)
                        //   → لا نحذف بيانات الجلسة، لأن الكود مرتبط بـ auth keys الحالية
                        //   → نعيد الاتصال بنفس الـ credentials بدون طلب كود جديد
                        //   → نبقي الكود ظاهراً للمستخدم
                        //
                        // الحالة B: pairingRequested=false (لم يُرسل كود بعد)
                        //   → نعيد بدء الجلسة كاملاً (الطريقة القديمة)
                        // ────────────────────────────────────────────────────────────────
                        const attempts = (this.reconnectAttempts.get(accountId) || 0) + 1;
                        this.reconnectAttempts.set(accountId, attempts);
                        const delay = Math.min(attempts * 2000, 10000);

                        if (pairingRequested) {
                            // ✅ FIX: الكود أُرسل — أبقِ نفس الـ auth keys وأعِد الاتصال
                            console.log(`[PAIRING_CODE_SENT] Account ${accountId}: 408 after code sent — reconnecting with SAME creds (attempt ${attempts})`);

                            // أبقِ الكود ظاهراً للمستخدم وأخبره بأن الاتصال جارٍ
                            const cachedCode = this.lastPairingCode.get(accountId);
                            this._emitState(accountId, 'pairing_ready', {
                                code: cachedCode?.code || undefined,
                                reconnecting: true,
                            });
                            // إعادة إرسال الكود صراحةً لضمان ظهوره في الواجهة
                            if (this.io && cachedCode?.code) {
                                this.io.to(`account_${accountId}`).emit('pairing_code', {
                                    code: cachedCode.code,
                                    phone: phoneNumber,
                                    reconnecting: true,
                                });
                            }

                            if (attempts <= 5) {
                                // [FIX-PAIRING-408] إعادة الاتصال بنفس الـ credentials (لا حذف جلسة)
                                this._scheduleReconnect(accountId, delay, () =>
                                    this._retryPairingWithSameCreds(accountId, phoneNumber)
                                );
                            } else {
                                console.warn(`[PAIRING_FAILED] Account ${accountId}: max reconnect attempts (${attempts}) reached after code sent`);
                                this._emitState(accountId, 'error', {
                                    error: 'انقطع الاتصال. الرجاء طلب كود جديد.',
                                });
                                if (this.io) {
                                    this.io.to(`account_${accountId}`).emit('pairing_error', {
                                        error: 'انقطع الاتصال أكثر من 5 مرات. اضغط "إعادة المحاولة" للحصول على كود جديد.',
                                    });
                                }
                            }
                        } else {
                            // لم يُرسل كود بعد — أعِد البدء كاملاً
                            this._emitState(accountId, 'disconnected', { reason: statusCode, attempt: attempts });

                            if (attempts <= 3) {
                                console.log(`[PAIRING_START] Account ${accountId}: 408 before code — retrying pairing in ${delay}ms (attempt ${attempts})`);
                                this._scheduleReconnect(accountId, delay, () => this.initPairingSession(accountId, phoneNumber));
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
                        }
                        return;
                    }

                    // متصل بنجاح
                    if (connection === 'open') {
                        clearTimeout(pairingTimer);
                        this.pairingTimers.delete(accountId);

                        console.log(`[AUTH_SUCCESS] Account ${accountId}: Pairing connection open — connected successfully.`);
                        console.log(`[PAIRING_SUCCESS] Account ${accountId}: WhatsApp account linked via Pairing Code.`);

                        this.reconnectAttempts.delete(accountId);
                        this.restartAttempts.delete(accountId);
                        // (مُسجَّل بالفعل في this.sessions منذ إنشاء الـ socket — [FIX-SESSION-TRACK])

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

                // [FIX-SESSION-TRACK] الـ socket مُسجَّل في this.sessions منذ سطر الإنشاء أعلاه
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

    // ────────────────────────────────────────────────────────────────────────
    // [FIX-PAIRING-408] _retryPairingWithSameCreds
    //
    // إعادة الاتصال بنفس الـ auth keys دون حذف بيانات الجلسة.
    // يُستدعى بعد 408 عندما يكون الكود قد أُرسل بالفعل.
    //
    // الفرق الجوهري عن initPairingSession:
    //   - لا يحذف بيانات الجلسة
    //   - لا يطلب pairing code جديد عند ظهور QR event
    //   - إذا الـ creds أصبحت registered → يُحوِّل إلى initSession العادية
    // ────────────────────────────────────────────────────────────────────────
    async _retryPairingWithSameCreds(accountId, phoneNumber) {
        // إنهاء أي socket قائم
        const old = this.sessions.get(accountId);
        if (old) { try { old.end(undefined); } catch {} this.sessions.delete(accountId); }
        this.initPromises.delete(accountId);

        console.log(`[PAIRING_REQUESTED] Account ${accountId}: retrying connection with existing creds (no session delete)`);
        this._emitState(accountId, 'pairing_starting');

        const retryPromise = (async () => {
            try {
                const { state, saveCreds } = await this._usePostgresAuthState(accountId);
                const waVersion = await this._fetchWAVersion();

                // إذا كانت الـ creds مسجلة → ننتقل لـ initSession مباشرة
                if (state.creds?.registered) {
                    console.log(`[PAIRING_SUCCESS] Account ${accountId}: creds registered — transitioning to full session`);
                    return this.initSession(accountId);
                }

                const sock = makeWASocket({
                    auth:               state,
                    version:            waVersion,
                    logger:             this.logger,
                    printQRInTerminal:  false,
                    keepAliveIntervalMs: 25_000,
                    connectTimeoutMs:    60_000,
                    browser:             Browsers.macOS('Chrome'),
                    syncFullHistory:     false,
                    markOnlineOnConnect: false,
                    retryRequestDelayMs: 500,
                    maxRetries:          5,
                });

                sock.ev.on('creds.update', saveCreds);

                // [FIX-SESSION-TRACK] نفس إصلاح initPairingSession — تسجيل فوري لمنع تنافس sockets
                this.sessions.set(accountId, sock);

                sock.ev.on('connection.update', async (update) => {
                    const { connection, lastDisconnect, qr } = update;

                    // QR event — لا نطلب كوداً جديداً، نُبقي الكود الحالي ونُعيد حالة pairing_ready
                    if (qr) {
                        const cachedCode = this.lastPairingCode.get(accountId);
                        if (cachedCode?.code) {
                            console.log(`[PAIRING_CODE_SENT] Account ${accountId}: QR fired during retry — keeping existing code ${cachedCode.code}`);
                            this._emitState(accountId, 'pairing_ready', { code: cachedCode.code });
                            if (this.io) {
                                this.io.to(`account_${accountId}`).emit('pairing_code', {
                                    code: cachedCode.code, phone: phoneNumber,
                                });
                            }
                        } else {
                            // الكود انتهى — اطلب كوداً جديداً
                            console.log(`[PAIRING_START] Account ${accountId}: code expired during retry — requesting new code`);
                            this._emitState(accountId, 'pairing_generating');
                            try {
                                const newCode = await sock.requestPairingCode(phoneNumber);
                                const formatted = newCode?.match(/.{1,4}/g)?.join('-') || newCode;
                                this.lastPairingCode.set(accountId, { code: formatted, ts: Date.now() });
                                this._emitState(accountId, 'pairing_ready', { code: formatted });
                                if (this.io) {
                                    this.io.to(`account_${accountId}`).emit('pairing_code', { code: formatted, phone: phoneNumber });
                                    console.log(`[PAIRING_CODE_RECEIVED] Account ${accountId}: new code ${formatted}`);
                                    console.log(`[PAIRING_CODE_SENT] Account ${accountId}: new code sent to frontend`);
                                }
                            } catch (err) {
                                console.error(`[PAIRING_FAILED] Account ${accountId}: requestPairingCode error:`, err.message);
                                this._emitState(accountId, 'error', { error: err.message });
                            }
                        }
                        return;
                    }

                    if (connection === 'close') {
                        const statusCode = new Boom.Boom(lastDisconnect?.error)?.output?.statusCode;
                        console.log(`[SOCKET_DISCONNECTED] Account ${accountId}: retry connection closed. Code: ${statusCode}`);
                        this.sessions.delete(accountId);
                        this.initPromises.delete(accountId);

                        if (CLEAR_SESSION_CODES.has(statusCode)) {
                            await this._clearSession(accountId, statusCode);
                            return;
                        }

                        if (statusCode === DisconnectReason.restartRequired) {
                            // [ROOT FIX] نفس الإصلاح الجذري — تعيين registered=true
                            if (state.creds && !state.creds.registered) {
                                state.creds.registered = true;
                                console.log(`[PAIRING_SUCCESS] Account ${accountId}: retry 515 — forcing registered=true before reconnect.`);
                            }
                            await saveCreds().catch(() => {});
                            if (state.creds?.registered) {
                                this.postScanReconnect.add(accountId);
                                this._scheduleReconnect(accountId, 4000, () => this.initSession(accountId));
                            } else {
                                this._scheduleReconnect(accountId, 3000, () => this._retryPairingWithSameCreds(accountId, phoneNumber));
                            }
                            return;
                        }

                        // 408 مجدداً — أعِد المحاولة مع نفس الـ creds
                        if (TEMP_DISCONNECT_CODES.has(statusCode)) {
                            const retryAttempts = (this.reconnectAttempts.get(accountId) || 0) + 1;
                            this.reconnectAttempts.set(accountId, retryAttempts);
                            const cachedCode = this.lastPairingCode.get(accountId);
                            if (cachedCode?.code) {
                                this._emitState(accountId, 'pairing_ready', { code: cachedCode.code, reconnecting: true });
                                if (this.io) {
                                    this.io.to(`account_${accountId}`).emit('pairing_code', { code: cachedCode.code, phone: phoneNumber });
                                }
                            }
                            if (retryAttempts <= 5) {
                                const retryDelay = Math.min(retryAttempts * 2000, 10000);
                                this._scheduleReconnect(accountId, retryDelay, () => this._retryPairingWithSameCreds(accountId, phoneNumber));
                            } else {
                                this._emitState(accountId, 'error', { error: 'انقطع الاتصال. اضغط "إعادة المحاولة" للحصول على كود جديد.' });
                            }
                            return;
                        }

                        // أي كود آخر → إعادة محاولة كاملة
                        this._scheduleReconnect(accountId, 3000, () => this.initPairingSession(accountId, phoneNumber));
                    }

                    if (connection === 'open') {
                        console.log(`[PAIRING_SUCCESS] Account ${accountId}: connected via pairing retry`);
                        this.reconnectAttempts.delete(accountId);
                        // (مُسجَّل بالفعل في this.sessions منذ إنشاء الـ socket)
                        this._emitState(accountId, 'connected');
                        await DatabaseManager.systemDB.run(
                            `UPDATE accounts SET status = 'connected', health_status = 'normal',
                             connection_type = 'pairing_code', phone_number = $1, updated_at = NOW()
                             WHERE id = $2`,
                            [phoneNumber, accountId]
                        ).catch(console.error);
                        if (this.io) {
                            this.io.emit('account_status', { accountId, status: 'connected' });
                            this.io.to(`account_${accountId}`).emit('account_status', { accountId, status: 'connected' });
                        }
                    }
                });

                return sock;
            } catch (err) {
                this.initPromises.delete(accountId);
                console.error(`[PAIRING_FAILED] Account ${accountId}: _retryPairingWithSameCreds error:`, err.message);
                this._emitState(accountId, 'error', { error: err.message });
                throw err;
            }
        })();

        this.initPromises.set(accountId, retryPromise);
        return await retryPromise;
    }

    // ── Force Reset ───────────────────────────────────────────────────────────
    async forceResetSession(accountId) {
        await this._clearSession(accountId, 'force_reset');
        return true;
    }

    // ────────────────────────────────────────────────────────────────────────
    // [FIX-QR] startFreshQRSession — يُستخدم من connectAccount endpoint
    //
    // السبب: initSession وحده لا يكفي لأنه:
    //   1. إذا وُجد creds.registered=true → يتخطى QR ويذهب مباشرة لـ connecting
    //   2. إذا كان connection_type='pairing_code' → يُعيد التوجيه لـ initPairingSession
    //
    // الحل: نظّف كل شيء أولاً (ذاكرة + قاعدة بيانات) ثم ابدأ جلسة QR نظيفة.
    // ────────────────────────────────────────────────────────────────────────
    async startFreshQRSession(accountId) {
        console.log(`[QR_START] Account ${accountId}: starting fresh QR session`);

        // 1. تنظيف الذاكرة والـ timers والـ FSM
        this._cleanupAccount(accountId);

        // 2. مسح بيانات الجلسة من قاعدة البيانات (يضمن عدم تخطي QR)
        await SystemDB.deleteAllSessionData(accountId).catch(() => {});

        // 3. إعادة تعيين نوع الاتصال لـ qr_code في DB
        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET connection_type = 'qr_code', status = 'disconnected', updated_at = NOW() WHERE id = $1`,
            [accountId]
        ).catch(() => {});

        console.log(`[QR_START] Account ${accountId}: session cleared, initiating QR generation`);

        // 4. بدء جلسة QR نظيفة (fire & forget — الأحداث تصل عبر Socket)
        this.initSession(accountId).catch(err =>
            console.error(`[QR_START] Account ${accountId}: initSession error:`, err.message)
        );

        return true;
    }

    // ────────────────────────────────────────────────────────────────────────
    // [FIX-DISCONNECT] disconnectAccount — كانت مفقودة وتسبب "is not a function"
    // ────────────────────────────────────────────────────────────────────────
    async disconnectAccount(accountId) {
        console.log(`[SOCKET_DISCONNECTED] Account ${accountId}: manual disconnect requested`);
        this._cleanupAccount(accountId);
        await DatabaseManager.systemDB.run(
            `UPDATE accounts SET status = 'disconnected', updated_at = NOW() WHERE id = $1`,
            [accountId]
        ).catch(() => {});
        return true;
    }

    /**
     * ✅ NEW: حذف الحساب بالكامل — يُستخدم من AccountController.deleteAccount
     * [FIX-1] يستخدم _cleanupAccount لضمان تنظيف جميع الـ timers والـ Maps
     */
    async fullDeleteAccount(accountId) {
        console.log(`[WhatsAppManager] Full delete for account ${accountId}…`);

        // 1. logout آمن قبل التنظيف
        const sock = this.sessions.get(accountId);
        if (sock) {
            try { await sock.logout().catch(() => {}); } catch (_) {}
        }

        // 2. [FIX-1] تنظيف شامل عبر _cleanupAccount
        this._cleanupAccount(accountId);

        // 3. تنظيف Redis keys (Rate Limiting لجميع الساعات الأخيرة)
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

