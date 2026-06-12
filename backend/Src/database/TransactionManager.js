'use strict';
/**
 * TransactionManager — PostgreSQL Transaction Wrapper
 * المرحلة 2: Database Hardening
 *
 * يوفر:
 *   - withTransaction(fn)        : تنفيذ عمليات متعددة في transaction واحدة (SystemDB)
 *   - withAccountTransaction(accountDB, fn): نفس الشيء لـ AccountDB مع search_path صحيح
 *   - retryDeadlock(fn, n)       : إعادة المحاولة تلقائياً عند Deadlock/Serialization Error
 */
const { getPool } = require('../lib/postgres');

class TransactionManager {

    /**
     * تنفيذ دالة داخل PostgreSQL transaction على SystemDB (public schema).
     * في حال الخطأ → ROLLBACK تلقائي، ثم رمي الاستثناء للأعلى.
     *
     * @param {(client: import('pg').PoolClient) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withTransaction(fn) {
        const client = await getPool().connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            try { await client.query('SET search_path TO public'); } catch {}
            client.release();
        }
    }

    /**
     * تنفيذ دالة داخل PostgreSQL transaction على AccountDB (tenant schema).
     * يضبط search_path تلقائياً لعزل المستأجر.
     *
     * @param {import('./AccountDB')} accountDB
     * @param {(client: import('pg').PoolClient) => Promise<T>} fn
     * @returns {Promise<T>}
     */
    async withAccountTransaction(accountDB, fn) {
        const client = await getPool().connect();
        try {
            await client.query(`SET search_path TO ${accountDB.schema}, public`);
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            try { await client.query('SET search_path TO public'); } catch {}
            client.release();
        }
    }

    /**
     * إعادة المحاولة تلقائياً عند أخطاء Deadlock أو Serialization.
     * PostgreSQL error codes:
     *   40001 = serialization_failure
     *   40P01 = deadlock_detected
     *
     * @param {() => Promise<T>} fn
     * @param {number} maxRetries
     * @returns {Promise<T>}
     */
    async retryDeadlock(fn, maxRetries = 3) {
        let attempt = 0;
        while (true) {
            try {
                return await fn();
            } catch (err) {
                attempt++;
                const isRetryable = err.code === '40001' || err.code === '40P01';
                if (isRetryable && attempt < maxRetries) {
                    const delay = Math.min(100 * Math.pow(2, attempt), 1000);
                    console.warn(`[TransactionManager] Retryable error (${err.code}), attempt ${attempt}/${maxRetries}, wait ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
    }
}

module.exports = new TransactionManager();
