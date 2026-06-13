'use strict';
/**
 * StateMachine.js — FIX-9: Finite State Machine لحالات اتصال WhatsApp
 *
 * الحالات المتاحة:
 *   idle          → الحساب موجود لكن لم يبدأ تهيئة بعد
 *   initializing  → جارٍ تحميل بيانات الجلسة من قاعدة البيانات
 *   qr_generating → جارٍ إنشاء رمز QR (socket يتصل بـ WhatsApp)
 *   qr_ready      → رمز QR جاهز وبانتظار المسح
 *   pairing_starting   → جارٍ بدء جلسة Pairing Code
 *   pairing_generating → جارٍ توليد Pairing Code
 *   pairing_ready      → Pairing Code جاهز وبانتظار الإدخال
 *   scanning      → المستخدم يمسح QR / يدخل Pairing Code
 *   connecting    → Socket يتصل بعد المصادقة
 *   connected     → متصل وجاهز للإرسال
 *   disconnected  → انقطع الاتصال، ربما يُعاد لاحقاً
 *   error         → خطأ نهائي يحتاج تدخل يدوي
 *
 * الانتقالات المسموحة (من → إلى[]):
 */

const EventBus = require('./EventBus');

const VALID_TRANSITIONS = {
    idle:               ['initializing', 'qr_generating', 'pairing_starting'],
    initializing:       ['qr_generating', 'pairing_starting', 'connecting', 'error', 'disconnected', 'idle'],
    // [FIX-CROSS] إضافة pairing_starting لتسمح التبديل من QR إلى Pairing
    qr_generating:      ['qr_ready', 'error', 'disconnected', 'initializing', 'pairing_starting'],
    // [FIX-CROSS] إضافة pairing_starting لتسمح التبديل من QR جاهز إلى Pairing
    qr_ready:           ['scanning', 'connecting', 'disconnected', 'error', 'qr_ready', 'initializing', 'qr_generating', 'pairing_starting'],
    // [FIX-CROSS] إضافة qr_generating لتسمح التبديل من Pairing إلى QR
    pairing_starting:   ['pairing_generating', 'error', 'disconnected', 'initializing', 'qr_generating'],
    // [FIX-CROSS] إضافة qr_generating لتسمح التبديل من Pairing generating إلى QR
    pairing_generating: ['pairing_ready', 'error', 'disconnected', 'initializing', 'qr_generating', 'pairing_starting'],
    // [FIX-CROSS] إضافة qr_generating لتسمح التبديل من Pairing ready إلى QR
    pairing_ready:      ['scanning', 'connecting', 'disconnected', 'error', 'initializing', 'qr_generating', 'pairing_starting'],
    scanning:           ['connecting', 'qr_generating', 'error', 'disconnected', 'initializing', 'pairing_starting'],
    // [FIX] connecting → initializing مطلوب عند إعادة التهيئة بعد 515/reconnect
    connecting:         ['connected', 'qr_generating', 'pairing_starting', 'disconnected', 'error', 'initializing'],
    connected:          ['disconnected', 'error', 'initializing', 'qr_generating', 'pairing_starting'],
    disconnected:       ['initializing', 'idle', 'error', 'pairing_starting', 'qr_generating'],
    error:              ['idle', 'initializing', 'disconnected', 'pairing_starting', 'qr_generating'],
};

// الحالات التي لا تحتاج QR جديد عند الاسترداد
const RECOVERABLE_STATES = new Set(['disconnected', 'error', 'connecting']);
// الحالات التي تحتاج QR جديد (جلسة منتهية)
const AUTH_FAILURE_STATES = new Set(['idle']);

class StateMachine {
    constructor() {
        // accountId → { state, enteredAt, history: [{state, ts}] }
        this._states = new Map();
    }

    /**
     * تهيئة حساب جديد في FSM
     */
    init(accountId, initialState = 'idle') {
        if (!this._states.has(accountId)) {
            this._states.set(accountId, {
                state:     initialState,
                enteredAt: Date.now(),
                history:   [{ state: initialState, ts: Date.now() }],
            });
        }
        return this.getState(accountId);
    }

    /**
     * الحصول على الحالة الحالية
     */
    getState(accountId) {
        return this._states.get(accountId)?.state ?? 'idle';
    }

    /**
     * الحصول على سجل الحالات
     */
    getHistory(accountId, limit = 10) {
        const rec = this._states.get(accountId);
        if (!rec) return [];
        return rec.history.slice(-limit);
    }

    /**
     * الحصول على وقت دخول الحالة الحالية (ms)
     */
    getStateDuration(accountId) {
        const rec = this._states.get(accountId);
        if (!rec) return 0;
        return Date.now() - rec.enteredAt;
    }

    /**
     * محاولة الانتقال إلى حالة جديدة.
     * يُعيد true عند النجاح، false عند الانتقال غير المسموح.
     * يُصدر حدث EventBus عند كل انتقال ناجح.
     */
    transition(accountId, newState, extra = {}) {
        const rec      = this._states.get(accountId);
        const current  = rec?.state ?? 'idle';

        if (!rec) {
            // تهيئة تلقائية
            this.init(accountId, 'idle');
            return this.transition(accountId, newState, extra);
        }

        const allowed = VALID_TRANSITIONS[current] ?? [];

        if (!allowed.includes(newState)) {
            console.warn(
                `[StateMachine] Account ${accountId}: INVALID transition ${current} → ${newState} (allowed: ${allowed.join(', ')})`
            );
            return false;
        }

        const from       = current;
        rec.state        = newState;
        rec.enteredAt    = Date.now();
        rec.history.push({ state: newState, ts: Date.now(), extra });

        // الحد من حجم السجل
        if (rec.history.length > 50) rec.history.shift();

        // إصدار حدث EventBus
        EventBus.emitStateChange(accountId, from, newState, extra);

        console.log(`[StateMachine] Account ${accountId}: ${from} → ${newState}`);
        return true;
    }

    /**
     * انتقال قسري (يتجاوز التحقق) — استخدم بحذر
     */
    forceTransition(accountId, newState, extra = {}) {
        if (!this._states.has(accountId)) this.init(accountId);
        const rec = this._states.get(accountId);
        const from = rec.state;
        rec.state     = newState;
        rec.enteredAt = Date.now();
        rec.history.push({ state: newState, ts: Date.now(), extra, forced: true });
        if (rec.history.length > 50) rec.history.shift();
        EventBus.emitStateChange(accountId, from, newState, extra);
        console.warn(`[StateMachine] Account ${accountId}: FORCED ${from} → ${newState}`);
    }

    /**
     * هل يمكن إعادة الاتصال دون QR جديد؟
     */
    isRecoverable(accountId) {
        return RECOVERABLE_STATES.has(this.getState(accountId));
    }

    /**
     * هل الحساب متصل؟
     */
    isConnected(accountId) {
        return this.getState(accountId) === 'connected';
    }

    /**
     * تنظيف بيانات الحساب من FSM
     */
    cleanup(accountId) {
        this._states.delete(accountId);
    }

    /**
     * إحصاءات لجميع الحسابات
     */
    getStats() {
        const counts = {};
        for (const [, rec] of this._states) {
            counts[rec.state] = (counts[rec.state] || 0) + 1;
        }
        return counts;
    }
}

// Singleton
const fsm = new StateMachine();
module.exports = fsm;
