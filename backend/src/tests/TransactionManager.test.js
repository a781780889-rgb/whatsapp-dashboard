'use strict';
/**
 * TransactionManager.test.js
 * المرحلة 8: Code Quality — FIX-29: Unit Tests
 *
 * يختبر:
 *   1. withTransaction      — commit ناجح
 *   2. withTransaction      — rollback عند الخطأ
 *   3. withAccountTransaction — ضبط search_path صحيح
 *   4. retryDeadlock        — إعادة المحاولة عند Deadlock
 *   5. retryDeadlock        — رمي الخطأ بعد استنفاد المحاولات
 */

const TransactionManager = require('../database/TransactionManager');

// ── Mock لـ pg Pool client ────────────────────────────────────────────────────

function makeMockClient({ failOn = null, deadlockTimes = 0 } = {}) {
    let deadlockCount = 0;
    const queries = [];

    const client = {
        _queries: queries,
        query: jest.fn(async (sql) => {
            queries.push(sql);
            if (failOn && sql.includes(failOn)) {
                const err = new Error(`Mock query failed: ${sql}`);
                throw err;
            }
            return { rows: [], rowCount: 0 };
        }),
        release: jest.fn(),
    };
    return client;
}

function mockPool(client) {
    return { connect: jest.fn().mockResolvedValue(client) };
}

// نستبدل require('../../lib/postgres') بـ mock
jest.mock('../lib/postgres', () => {
    let _pool = null;
    return {
        getPool:  () => _pool,
        __setPool: (p) => { _pool = p; },
    };
});

const { getPool, __setPool } = require('../lib/postgres');

// ── الاختبارات ────────────────────────────────────────────────────────────────

describe('TransactionManager', () => {

    // ═══════════════════════════════════════════════════════════════════════════
    // withTransaction
    // ═══════════════════════════════════════════════════════════════════════════
    describe('withTransaction()', () => {

        test('يُنفّذ BEGIN ثم fn ثم COMMIT ويُعيد النتيجة', async () => {
            const client = makeMockClient();
            __setPool(mockPool(client));

            const result = await TransactionManager.withTransaction(async (c) => {
                return 'hello';
            });

            expect(result).toBe('hello');
            expect(client.query).toHaveBeenCalledWith('BEGIN');
            expect(client.query).toHaveBeenCalledWith('COMMIT');
            expect(client.release).toHaveBeenCalledTimes(1);
        });

        test('يُنفّذ ROLLBACK عند رمي خطأ داخل fn', async () => {
            const client = makeMockClient();
            __setPool(mockPool(client));

            await expect(
                TransactionManager.withTransaction(async () => {
                    throw new Error('boom');
                })
            ).rejects.toThrow('boom');

            expect(client.query).toHaveBeenCalledWith('ROLLBACK');
            expect(client.release).toHaveBeenCalledTimes(1);
        });

        test('يُطلق client.release حتى عند وجود خطأ', async () => {
            const client = makeMockClient();
            __setPool(mockPool(client));

            try {
                await TransactionManager.withTransaction(async () => {
                    throw new Error('release test');
                });
            } catch {}

            expect(client.release).toHaveBeenCalledTimes(1);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // withAccountTransaction
    // ═══════════════════════════════════════════════════════════════════════════
    describe('withAccountTransaction()', () => {

        test('يضبط search_path على schema الحساب قبل BEGIN', async () => {
            const client = makeMockClient();
            __setPool(mockPool(client));

            const fakeAccountDB = { schema: 'acc_test123' };

            await TransactionManager.withAccountTransaction(fakeAccountDB, async () => {
                return 'ok';
            });

            const querySequence = client.query.mock.calls.map(c => c[0]);
            const searchPathIdx = querySequence.indexOf(`SET search_path TO acc_test123, public`);
            const beginIdx      = querySequence.indexOf('BEGIN');
            const commitIdx     = querySequence.indexOf('COMMIT');

            expect(searchPathIdx).toBeGreaterThanOrEqual(0);
            expect(beginIdx).toBeGreaterThan(searchPathIdx);
            expect(commitIdx).toBeGreaterThan(beginIdx);
        });

        test('يُعيد search_path إلى public في finally', async () => {
            const client = makeMockClient();
            __setPool(mockPool(client));

            const fakeAccountDB = { schema: 'acc_xyz' };
            try {
                await TransactionManager.withAccountTransaction(fakeAccountDB, async () => {
                    throw new Error('err');
                });
            } catch {}

            const querySequence = client.query.mock.calls.map(c => c[0]);
            const lastRestore = querySequence.lastIndexOf('SET search_path TO public');
            expect(lastRestore).toBeGreaterThan(-1);
        });
    });

    // ═══════════════════════════════════════════════════════════════════════════
    // retryDeadlock
    // ═══════════════════════════════════════════════════════════════════════════
    describe('retryDeadlock()', () => {

        test('يُعيد النتيجة مباشرةً إذا نجحت fn من أول مرة', async () => {
            const fn = jest.fn().mockResolvedValue(42);
            const result = await TransactionManager.retryDeadlock(fn);
            expect(result).toBe(42);
            expect(fn).toHaveBeenCalledTimes(1);
        });

        test('يُعيد المحاولة عند خطأ Deadlock (code=40P01)', async () => {
            const deadlockErr = Object.assign(new Error('deadlock'), { code: '40P01' });
            const fn = jest.fn()
                .mockRejectedValueOnce(deadlockErr)
                .mockResolvedValue('recovered');

            const result = await TransactionManager.retryDeadlock(fn, 3);
            expect(result).toBe('recovered');
            expect(fn).toHaveBeenCalledTimes(2);
        });

        test('يُعيد المحاولة عند خطأ Serialization (code=40001)', async () => {
            const serErr = Object.assign(new Error('serialization'), { code: '40001' });
            const fn = jest.fn()
                .mockRejectedValueOnce(serErr)
                .mockRejectedValueOnce(serErr)
                .mockResolvedValue('final');

            const result = await TransactionManager.retryDeadlock(fn, 3);
            expect(result).toBe('final');
            expect(fn).toHaveBeenCalledTimes(3);
        });

        test('يرمي الخطأ بعد استنفاد maxRetries', async () => {
            const deadlockErr = Object.assign(new Error('persistent deadlock'), { code: '40P01' });
            const fn = jest.fn().mockRejectedValue(deadlockErr);

            await expect(TransactionManager.retryDeadlock(fn, 3)).rejects.toThrow('persistent deadlock');
            expect(fn).toHaveBeenCalledTimes(3);
        });

        test('لا يُعيد المحاولة على خطأ غير قابل للتكرار', async () => {
            const genericErr = new Error('unique_violation');
            genericErr.code  = '23505';
            const fn = jest.fn().mockRejectedValue(genericErr);

            await expect(TransactionManager.retryDeadlock(fn, 3)).rejects.toThrow('unique_violation');
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });
});
