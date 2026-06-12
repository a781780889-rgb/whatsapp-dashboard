'use strict';
/**
 * StateMachine.test.js
 * المرحلة 8: Code Quality — FIX-29: Unit Tests
 *
 * يختبر:
 *   1. init                 — تهيئة الحساب بالحالة الافتراضية
 *   2. getState             — قراءة الحالة الحالية
 *   3. transition           — انتقال صحيح وانتقال مرفوض
 *   4. forceTransition      — تجاوز القيود
 *   5. getHistory           — سجل الانتقالات
 *   6. getStateDuration     — مدة الحالة
 *   7. isRecoverable        — الحالات القابلة للاسترداد
 *   8. isConnected          — فحص الاتصال
 *   9. cleanup              — تنظيف بيانات الحساب
 *   10. getStats            — إحصاءات كل الحسابات
 *   11. EventBus integration — إصدار الحدث عند الانتقال
 */

// ── Mock EventBus لتجنب side effects ─────────────────────────────────────────
jest.mock('../core/EventBus', () => ({
    emitStateChange: jest.fn(),
}));

const EventBus = require('../core/EventBus');

// نستورد StateMachine بعد المـock لنحصل على instance نظيفة لكل اختبار
let StateMachine;

describe('StateMachine', () => {

    beforeEach(() => {
        // نُنشئ instance جديدة لكل اختبار لعزل الحالة
        jest.resetModules();
        jest.mock('../core/EventBus', () => ({ emitStateChange: jest.fn() }));
        StateMachine = require('../core/StateMachine');
        // تنظيف أي حسابات سابقة (الـ singleton داخلي)
        // نُنشئ حسابات اختبارية فريدة
    });

    const ACC = () => `test-${Math.random().toString(36).slice(2)}`;

    // ═══════════════════════════════════════════════════════════════════════════
    // init & getState
    // ═══════════════════════════════════════════════════════════════════════════
    describe('init()', () => {
        test('يُهيّئ الحساب بحالة idle افتراضياً', () => {
            const id = ACC();
            StateMachine.init(id);
            expect(StateMachine.getState(id)).toBe('idle');
        });

        test('يقبل حالة ابتدائية مخصصة', () => {
            const id = ACC();
            StateMachine.init(id, 'disconnected');
            expect(StateMachine.getState(id)).toBe('disconnected');
        });

        test('لا يُعيد تهيئة حساب موجود بالفعل', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            StateMachine.transition(id, 'initializing');
            StateMachine.init(id, 'idle'); // يجب أن يُهمَل
            expect(StateMachine.getState(id)).toBe('initializing');
        });

        test('يُعيد الحالة الحالية', () => {
            const id = ACC();
            const state = StateMachine.init(id, 'idle');
            expect(state).toBe('idle');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // getState
    // ═══════════════════════════════════════════════════════════════════════════
    describe('getState()', () => {
        test('يُعيد idle لحساب غير معروف', () => {
            expect(StateMachine.getState('non-existent-123')).toBe('idle');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // transition
    // ═══════════════════════════════════════════════════════════════════════════
    describe('transition()', () => {
        test('يُنجز الانتقال المسموح ويُعيد true', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            const ok = StateMachine.transition(id, 'initializing');
            expect(ok).toBe(true);
            expect(StateMachine.getState(id)).toBe('initializing');
        });

        test('يرفض الانتقال غير المسموح ويُعيد false', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            const ok = StateMachine.transition(id, 'connected'); // idle → connected غير مسموح
            expect(ok).toBe(false);
            expect(StateMachine.getState(id)).toBe('idle');
        });

        test('يُهيّئ الحساب تلقائياً إن لم يكن موجوداً', () => {
            const id = ACC();
            // بدون init
            const ok = StateMachine.transition(id, 'initializing');
            expect(ok).toBe(true);
        });

        test('سلسلة انتقالات كاملة: idle → connected', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            expect(StateMachine.transition(id, 'initializing')).toBe(true);
            expect(StateMachine.transition(id, 'qr_generating')).toBe(true);
            expect(StateMachine.transition(id, 'qr_ready')).toBe(true);
            expect(StateMachine.transition(id, 'scanning')).toBe(true);
            expect(StateMachine.transition(id, 'connecting')).toBe(true);
            expect(StateMachine.transition(id, 'connected')).toBe(true);
            expect(StateMachine.getState(id)).toBe('connected');
        });

        test('يُصدر EventBus.emitStateChange عند الانتقال الناجح', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            const mockEmit = jest.spyOn(require('../core/EventBus'), 'emitStateChange');
            StateMachine.transition(id, 'initializing');
            expect(mockEmit).toHaveBeenCalledWith(id, 'idle', 'initializing', {});
        });

        test('لا يُصدر EventBus عند الانتقال المرفوض', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            const mockEmit = jest.spyOn(require('../core/EventBus'), 'emitStateChange');
            mockEmit.mockClear();
            StateMachine.transition(id, 'connected'); // غير مسموح
            expect(mockEmit).not.toHaveBeenCalled();
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // forceTransition
    // ═══════════════════════════════════════════════════════════════════════════
    describe('forceTransition()', () => {
        test('يُجبر الانتقال حتى لو كان غير مسموح', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            StateMachine.forceTransition(id, 'connected'); // غير مسموح عادةً
            expect(StateMachine.getState(id)).toBe('connected');
        });

        test('يُسجّل forced:true في السجل', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            StateMachine.forceTransition(id, 'connected');
            const history = StateMachine.getHistory(id);
            const forced = history.find(h => h.forced);
            expect(forced).toBeTruthy();
            expect(forced.state).toBe('connected');
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // getHistory
    // ═══════════════════════════════════════════════════════════════════════════
    describe('getHistory()', () => {
        test('يُعيد مصفوفة فارغة لحساب غير موجود', () => {
            expect(StateMachine.getHistory('unknown-999')).toEqual([]);
        });

        test('يحتوي على الحالة الابتدائية', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            const h = StateMachine.getHistory(id);
            expect(h[0].state).toBe('idle');
        });

        test('يُضيف كل انتقال للسجل', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            StateMachine.transition(id, 'initializing');
            StateMachine.transition(id, 'qr_generating');
            const h = StateMachine.getHistory(id);
            expect(h.length).toBe(3);
            expect(h.map(x => x.state)).toEqual(['idle', 'initializing', 'qr_generating']);
        });

        test('يحترم معامل limit', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            StateMachine.transition(id, 'initializing');
            StateMachine.transition(id, 'qr_generating');
            const h = StateMachine.getHistory(id, 2);
            expect(h.length).toBe(2);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // getStateDuration
    // ═══════════════════════════════════════════════════════════════════════════
    describe('getStateDuration()', () => {
        test('يُعيد 0 لحساب غير موجود', () => {
            expect(StateMachine.getStateDuration('ghost')).toBe(0);
        });

        test('يُعيد قيمة موجبة بعد الإنشاء', async () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            await new Promise(r => setTimeout(r, 10));
            expect(StateMachine.getStateDuration(id)).toBeGreaterThan(0);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // isRecoverable & isConnected
    // ═══════════════════════════════════════════════════════════════════════════
    describe('isRecoverable()', () => {
        test.each([
            ['disconnected', true],
            ['error',        true],
            ['connecting',   true],
            ['connected',    false],
            ['idle',         false],
            ['qr_ready',     false],
        ])('الحالة %s → isRecoverable=%s', (state, expected) => {
            const id = ACC();
            StateMachine.init(id, state);
            expect(StateMachine.isRecoverable(id)).toBe(expected);
        });
    });

    describe('isConnected()', () => {
        test('يُعيد true للحالة connected فقط', () => {
            const id = ACC();
            StateMachine.init(id, 'connected');
            expect(StateMachine.isConnected(id)).toBe(true);
        });

        test('يُعيد false لأي حالة أخرى', () => {
            const id = ACC();
            StateMachine.init(id, 'idle');
            expect(StateMachine.isConnected(id)).toBe(false);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // cleanup
    // ═══════════════════════════════════════════════════════════════════════════
    describe('cleanup()', () => {
        test('يحذف بيانات الحساب', () => {
            const id = ACC();
            StateMachine.init(id, 'connected');
            StateMachine.cleanup(id);
            expect(StateMachine.getState(id)).toBe('idle'); // fallback
            expect(StateMachine.getHistory(id)).toEqual([]);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // getStats
    // ═══════════════════════════════════════════════════════════════════════════
    describe('getStats()', () => {
        test('يحسب عدد الحسابات لكل حالة', () => {
            const ids = [ACC(), ACC(), ACC()];
            StateMachine.init(ids[0], 'connected');
            StateMachine.init(ids[1], 'connected');
            StateMachine.init(ids[2], 'disconnected');

            const stats = StateMachine.getStats();
            expect(stats.connected).toBeGreaterThanOrEqual(2);
            expect(stats.disconnected).toBeGreaterThanOrEqual(1);
        });
    });
});
