'use strict';
/**
 * SocketBridge.js — Phase 1: Global Socket Layer
 *
 * المشكلة المُصلَحة:
 *   - الاعتماد على Polling لتحديث حالة الحسابات في الواجهة.
 *   - تشتُّت io.emit() عبر ملفات متعددة (index.js، WhatsAppManager.js).
 *   - عدم وجود تتبع للـ Rooms النشطة.
 *
 * الحل:
 *   - طبقة مركزية وحيدة لجميع عمليات Socket.IO.
 *   - تتبع الـ Rooms النشطة لمنع الإرسال للغرف الفارغة.
 *   - Real-time State Synchronization عند تغيُّر حالة الحساب.
 *   - إزالة كاملة للـ Polling — جميع التحديثات تعتمد على الأحداث.
 */

class SocketBridge {
    constructor() {
        /** @type {import('socket.io').Server|null} */
        this._io = null;

        /** تتبع الـ rooms المُفعَّلة: accountId → Set<socketId> */
        this._rooms = new Map();
    }

    // ── تهيئة ─────────────────────────────────────────────────────────────

    /**
     * يُهيَّأ مرة واحدة عند بدء الخادم.
     * @param {import('socket.io').Server} io
     */
    init(io) {
        this._io = io;
        this._registerHandlers();
        console.log('[SocketBridge] Initialized. Real-time layer active.');
    }

    // ── تسجيل المعالجات ───────────────────────────────────────────────────

    _registerHandlers() {
        if (!this._io) return;

        this._io.on('connection', (socket) => {
            // ── الانضمام إلى غرفة الحساب ────────────────────────────────
            socket.on('join_account', (accountId) => {
                if (!accountId || typeof accountId !== 'string') return;

                socket.join(`account_${accountId}`);
                if (!this._rooms.has(accountId)) {
                    this._rooms.set(accountId, new Set());
                }
                this._rooms.get(accountId).add(socket.id);

                // ── Replay الحالة الحالية للـ client المتأخر (Race Condition Fix) ──
                this._replayState(socket, accountId);

                socket.on('disconnect', () => {
                    const room = this._rooms.get(accountId);
                    if (room) {
                        room.delete(socket.id);
                        if (room.size === 0) this._rooms.delete(accountId);
                    }
                });
            });

            // ── مغادرة غرفة الحساب ──────────────────────────────────────
            socket.on('leave_account', (accountId) => {
                if (!accountId) return;
                socket.leave(`account_${accountId}`);
                const room = this._rooms.get(accountId);
                if (room) {
                    room.delete(socket.id);
                    if (room.size === 0) this._rooms.delete(accountId);
                }
            });
        });
    }

    /**
     * يُعيد إرسال الحالة الكاملة للـ client المتأخر.
     * يحل مشكلة Race Condition: client يفتح Modal بعد إصدار QR.
     * [FIX-REPLAY] يتضمن QR و Code مباشرةً في connection_state لضمان الاستقبال.
     */
    _replayState(socket, accountId) {
        try {
            const WhatsAppManager = require('../bot/WhatsAppManager');
            const { state, qr, code } = WhatsAppManager.getStateSummary(accountId);

            // [FIX-REPLAY] إرسال الحالة مع QR/Code مضمّنَين مباشرةً
            socket.emit('connection_state', {
                accountId,
                state,
                ts:       Date.now(),
                replayed: true,
                // تضمين QR إذا كانت الحالة qr_ready
                ...(qr   ? { qr }   : {}),
                // تضمين Code إذا كانت الحالة pairing_ready
                ...(code ? { code } : {}),
            });

            // إعادة إرسال QR كحدث منفصل (للتوافقية مع handlers القديمة)
            if (qr) {
                socket.emit('qr_code', { qr, ts: Date.now(), replayed: true });
            }

            // إعادة إرسال Pairing Code كحدث منفصل
            if (code) {
                socket.emit('pairing_code', { code, ts: Date.now(), replayed: true });
            }

            // إرسال account_status إذا كان متصلاً
            if (state === 'connected') {
                socket.emit('account_status', {
                    accountId,
                    status:   'connected',
                    replayed: true,
                });
            }
        } catch (_) {
            // WhatsAppManager قد لا يكون جاهزاً بعد
        }
    }

    // ── إرسال للغرفة (room-specific) ─────────────────────────────────────

    /**
     * يُرسل حدثاً لجميع الـ clients في غرفة حساب معين.
     * @param {string} accountId
     * @param {string} event
     * @param {*} data
     */
    emitToAccount(accountId, event, data) {
        if (!this._io) return;
        this._io.to(`account_${accountId}`).emit(event, data);
    }

    /**
     * يُرسل تحديث حالة لحساب معين + البث العام.
     * @param {string} accountId
     * @param {'connected'|'disconnected'|'error'} status
     * @param {object} [extra]
     */
    emitAccountStatus(accountId, status, extra = {}) {
        if (!this._io) return;

        const payload = { accountId, status, ts: Date.now(), ...extra };

        // 1. الغرفة الخاصة بالحساب (Modal/Connection Dialog)
        this._io.to(`account_${accountId}`).emit('account_status', payload);

        // 2. البث العام (Dashboard/Accounts List)
        this._io.emit('account_status', payload);
    }

    /**
     * يُرسل تحديث connection_state.
     */
    emitConnectionState(accountId, state, extra = {}) {
        if (!this._io) return;
        this._io.to(`account_${accountId}`).emit('connection_state', {
            accountId,
            state,
            ts: Date.now(),
            ...extra,
        });
    }

    /**
     * يُرسل QR code لغرفة الحساب.
     */
    emitQR(accountId, qr) {
        if (!this._io) return;
        this._io.to(`account_${accountId}`).emit('qr_code', { qr, ts: Date.now() });
    }

    /**
     * يُرسل Pairing Code لغرفة الحساب.
     */
    emitPairingCode(accountId, code) {
        if (!this._io) return;
        this._io.to(`account_${accountId}`).emit('pairing_code', { code, ts: Date.now() });
    }

    /**
     * يُرسل خطأ اتصال.
     */
    emitConnectionError(accountId, error) {
        if (!this._io) return;
        this._io.to(`account_${accountId}`).emit('connection_error', { error, ts: Date.now() });
    }

    // ── البث العام ────────────────────────────────────────────────────────

    /**
     * يُرسل إشعاراً لجميع الـ clients.
     * @param {'success'|'error'|'warning'|'info'} type
     * @param {string} title
     * @param {string} message
     * @param {string} [accountId]
     */
    emitNotification(type, title, message, accountId = null) {
        if (!this._io) return;
        this._io.emit('notification', {
            type, title, message,
            accountId, ts: Date.now(),
        });
    }

    /**
     * يُرسل حدثاً لجميع الـ clients المتصلين.
     */
    broadcast(event, data) {
        if (!this._io) return;
        this._io.emit(event, { ...data, ts: Date.now() });
    }

    // ── معلومات ──────────────────────────────────────────────────────────

    /**
     * يُعيد عدد الـ clients في غرفة حساب معين.
     */
    getRoomSize(accountId) {
        return this._rooms.get(accountId)?.size || 0;
    }

    /**
     * يُعيد إجمالي الـ clients المتصلين.
     */
    getTotalConnections() {
        if (!this._io) return 0;
        return this._io.engine?.clientsCount || 0;
    }

    /**
     * يُعيد جميع الغرف النشطة.
     */
    getActiveRooms() {
        const result = {};
        for (const [accountId, sockets] of this._rooms.entries()) {
            result[accountId] = sockets.size;
        }
        return result;
    }

    /**
     * يُعيد true إذا كان هناك io مُهيَّأ.
     */
    get isReady() {
        return this._io !== null;
    }
}

// Singleton — يُستخدم عبر جميع الملفات
module.exports = new SocketBridge();
