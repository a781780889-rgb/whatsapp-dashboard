'use strict';
/**
 * PostgreSQL Pool — pg
 * Section 5.2 / 16.3 من وثيقة التحليل
 * Fix: keepAlive + reduced pool size + reconnect on error
 */
const { Pool } = require('pg');

let pool = null;

function createPool() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        throw new Error('[PostgreSQL] DATABASE_URL is required.');
    }

    const sslEnabled = process.env.DATABASE_SSL !== 'false';

    const p = new Pool({
        connectionString,
        ssl: sslEnabled ? { rejectUnauthorized: false } : false,
        max: parseInt(process.env.DB_POOL_MAX || '5', 10),      // ✅ خُفِّض من 20 إلى 5
        idleTimeoutMillis: 60000,                                 // ✅ زيادة وقت الانتظار
        connectionTimeoutMillis: 10000,                           // ✅ وقت أطول للاتصال
        keepAlive: true,                                          // ✅ منع انقطاع الاتصال
        keepAliveInitialDelayMillis: 10000,                       // ✅ إرسال keepalive بعد 10 ثوان
    });

    p.on('connect', () => {
        console.log('[PostgreSQL] New client connected.');
    });

    p.on('error', (err, client) => {
        console.error('[PostgreSQL] Pool error:', err.message);
        // إعادة إنشاء الـ pool إذا انقطع الاتصال نهائياً
        if (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' || err.message.includes('Connection terminated')) {
            console.log('[PostgreSQL] Recreating pool due to connection error...');
            pool = null;
        }
    });

    console.log('[PostgreSQL] Pool created. Max connections:', p.options.max);
    return p;
}

function getPool() {
    if (!pool) {
        pool = createPool();
    }
    return pool;
}

async function query(sql, params = []) {
    const p = getPool();
    try {
        return await p.query(sql, params);
    } catch (err) {
        // إذا انقطع الاتصال، نحذف الـ pool لإعادة إنشائه في المرة القادمة
        if (err.message.includes('Connection terminated') || err.code === 'ECONNRESET') {
            console.error('[PostgreSQL] Connection lost, will reconnect on next query.');
            pool = null;
        }
        console.error('[PostgreSQL] Query error:', err.message, '\nSQL:', sql.trim().slice(0, 200));
        throw err;
    }
}

async function queryOne(sql, params = []) {
    const res = await query(sql, params);
    return res.rows[0] || null;
}

async function queryAll(sql, params = []) {
    const res = await query(sql, params);
    return res.rows;
}

async function getClient() {
    return getPool().connect();
}

module.exports = { getPool, query, queryOne, queryAll, getClient };
