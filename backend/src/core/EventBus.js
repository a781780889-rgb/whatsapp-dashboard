'use strict';
/**
 * EventBus.js — FIX-11: Central Event Bus
 *
 * يفصل الأحداث عن المنطق: بدلاً من استدعاءات مباشرة بين الـ modules،
 * كل module يُصدر (emit) وكل module يستمع (on) دون معرفة بعضها البعض.
 *
 * الأحداث المدعومة:
 *   account:state_changed    → { accountId, from, to, extra }
 *   account:connected        → { accountId, phone }
 *   account:disconnected     → { accountId, reason, code }
 *   account:qr_ready         → { accountId, qr }
 *   account:pairing_ready    → { accountId, code }
 *   account:error            → { accountId, error }
 *   account:deleted          → { accountId }
 *   session:saved            → { accountId }
 *   session:restored         → { accountId }
 *   recovery:started         → { accountId, attempt, delay }
 *   recovery:success         → { accountId, attempt }
 *   recovery:failed          → { accountId, reason }
 *   recovery:auth_failure    → { accountId } — يحتاج QR جديد
 */

const { EventEmitter } = require('events');

class EventBus extends EventEmitter {
    constructor() {
        super();
        // السماح بعدد كبير من المستمعين (account لكل واحد مستمع)
        this.setMaxListeners(200);
        this._history = new Map(); // event → [{ data, ts }] آخر N أحداث لكل نوع
        this._historyLimit = 50;
    }

    /**
     * emit مع تسجيل في السجل لـ replay / debugging
     */
    emit(event, data) {
        // تخزين في السجل
        if (!this._history.has(event)) this._history.set(event, []);
        const bucket = this._history.get(event);
        bucket.push({ data, ts: Date.now() });
        if (bucket.length > this._historyLimit) bucket.shift();

        return super.emit(event, data);
    }

    /**
     * الحصول على آخر N أحداث لنوع معين
     */
    getHistory(event, limit = 10) {
        const bucket = this._history.get(event) || [];
        return bucket.slice(-limit);
    }

    /**
     * إصدار حدث تغيير حالة الحساب
     */
    emitStateChange(accountId, from, to, extra = {}) {
        this.emit('account:state_changed', { accountId, from, to, extra, ts: Date.now() });
    }

    /**
     * إصدار حدث اتصال ناجح
     */
    emitConnected(accountId, phone = null) {
        this.emit('account:connected', { accountId, phone, ts: Date.now() });
    }

    /**
     * إصدار حدث انقطاع
     */
    emitDisconnected(accountId, reason, code = null) {
        this.emit('account:disconnected', { accountId, reason, code, ts: Date.now() });
    }

    /**
     * إصدار حدث QR جاهز
     */
    emitQRReady(accountId, qr) {
        this.emit('account:qr_ready', { accountId, qr, ts: Date.now() });
    }

    /**
     * إصدار حدث Pairing Code جاهز
     */
    emitPairingReady(accountId, code) {
        this.emit('account:pairing_ready', { accountId, code, ts: Date.now() });
    }

    /**
     * إصدار حدث خطأ
     */
    emitError(accountId, error) {
        this.emit('account:error', { accountId, error, ts: Date.now() });
    }

    /**
     * إصدار حدث حذف حساب
     */
    emitDeleted(accountId) {
        this.emit('account:deleted', { accountId, ts: Date.now() });
    }

    /**
     * إصدار حدث بدء الاسترداد التلقائي
     */
    emitRecoveryStarted(accountId, attempt, delay) {
        this.emit('recovery:started', { accountId, attempt, delay, ts: Date.now() });
    }

    /**
     * إصدار حدث نجاح الاسترداد
     */
    emitRecoverySuccess(accountId, attempt) {
        this.emit('recovery:success', { accountId, attempt, ts: Date.now() });
    }

    /**
     * إصدار حدث فشل الاسترداد النهائي
     */
    emitRecoveryFailed(accountId, reason) {
        this.emit('recovery:failed', { accountId, reason, ts: Date.now() });
    }

    /**
     * إصدار حدث فشل المصادقة (يحتاج QR جديد)
     */
    emitAuthFailure(accountId) {
        this.emit('recovery:auth_failure', { accountId, ts: Date.now() });
    }
}

// Singleton
const bus = new EventBus();
module.exports = bus;
