'use strict';
/**
 * PostgreSQL Pool — pg
 * Section 5.2 / 16.3 من وثيقة التحليل:
 * الانتقال الفوري من SQLite → PostgreSQL ضروري للإنتاج.
 * يستخدم Connection Pooling عبر PgBouncer pattern داخلي.
 */
const { Pool } = require('pg');

let pool = null;

function getPool() {
    if (pool) return pool;

    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('[PostgreSQL] DATABASE_URL is required. Use Neon or Railway PostgreSQL (replacing SQLite per Section 16.3).');
    }

    const sslEnabled = process.env.DATABASE_SSL !== 'false';

    pool = new Pool({
        connectionString,
        ssl: sslEnabled ? { rejectUnauthorized: false } : false,
        max: parseInt(process.env.DB_POOL_MAX || '20', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    pool.on('connect', () => {});
    pool.on('error',   (err) => console.error('[PostgreSQL] Pool error:', err.message));

    console.log('[PostgreSQL] Pool created. Max connections:', pool.options.max);
    return pool;
}

/**
 * Execute any SQL query with positional $1..$N params.
 */
async function query(sql, params = []) {
    const p = getPool();
    try {
        return await p.query(sql, params);
    } catch (err) {
        console.error('[PostgreSQL] Query error:', err.message, '\nSQL:', sql.trim().slice(0, 200));
        throw err;
    }
}

/** Returns first row or null */
async function queryOne(sql, params = []) {
    const res = await query(sql, params);
    return res.rows[0] || null;
}

/** Returns all rows */
async function queryAll(sql, params = []) {
    const res = await query(sql, params);
    return res.rows;
}

/** Acquire a dedicated client (for transaction-style work) */
async function getClient() {
    return getPool().connect();
}

module.exports = { getPool, query, queryOne, queryAll, getClient };
