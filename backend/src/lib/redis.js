'use strict';
/**
 * Redis Client — ioredis
 *
 * ⚠️ BullMQ v5 يشترط صارماً:
 *   - maxRetriesPerRequest: null
 *   - enableReadyCheck: false
 *
 * لذلك نُصدِّر دالتَين:
 *   - getRedis()            → للاستخدام العام (Socket.IO, JWT blacklist, Rate limiting)
 *   - getBullMQConnection() → اتصال مستقل لـ BullMQ فقط
 */
const Redis = require('ioredis');

let client = null;

// ── General-purpose Redis client ─────────────────────────────────────────────
function getRedis() {
    if (client && client.status !== 'end') return client;

    const url = process.env.REDIS_URL;
    if (!url) throw new Error(
        '[Redis] REDIS_URL is required. Add it to your environment variables (Upstash free tier recommended for Railway).'
    );

    client = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        retryStrategy: (times) => {
            const delay = Math.min(times * 100, 3000);
            console.log(`[Redis] Reconnecting attempt ${times}, delay ${delay}ms`);
            return delay;
        },
        lazyConnect: false,
        connectTimeout: 10000,
    });

    client.on('connect',      () => console.log('[Redis] Connected successfully.'));
    client.on('ready',        () => console.log('[Redis] Ready to accept commands.'));
    client.on('error',        (err) => console.error('[Redis] Error:', err.message));
    client.on('close',        () => console.warn('[Redis] Connection closed.'));
    client.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

    return client;
}

// ── BullMQ-specific Redis connection ─────────────────────────────────────────
// BullMQ v5 يرفض أي اتصال لا يستوفي:
//   maxRetriesPerRequest: null  (BullMQ يدير الـ retries بنفسه)
//   enableReadyCheck:     false (يمنع blocking قبل جاهزية Redis)
//
// كل Queue/Worker/QueueEvents يحتاج instance مستقل → استدعِ الدالة لكل واحد.
function getBullMQConnection() {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('[Redis] REDIS_URL is required for BullMQ.');

    const conn = new Redis(url, {
        maxRetriesPerRequest: null,   // ← إلزامي لـ BullMQ
        enableReadyCheck:     false,  // ← إلزامي لـ BullMQ
        retryStrategy: (times) => {
            const delay = Math.min(times * 200, 5000);
            console.log(`[Redis/BullMQ] Reconnecting attempt ${times}, delay ${delay}ms`);
            return delay;
        },
        connectTimeout: 10000,
    });

    conn.on('error', (err) => console.error('[Redis/BullMQ] Error:', err.message));
    return conn;
}

module.exports = { getRedis, getBullMQConnection };
