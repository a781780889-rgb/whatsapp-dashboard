'use strict';
/**
 * Redis Client — ioredis
 * Section 5.2 / 11.2 / 9.3 من وثيقة التحليل:
 * Redis ضروري فوراً مع PostgreSQL لـ BullMQ + Socket.IO Adapter + JWT Blacklist + Rate Limiting
 */
const Redis = require('ioredis');

let client = null;

function getRedis() {
    if (client && client.status !== 'end') return client;

    const url = process.env.REDIS_URL;
    if (!url) throw new Error('[Redis] REDIS_URL is required. Add it to your environment variables (Upstash free tier recommended for Railway).');

    client = new Redis(url, {
        maxRetriesPerRequest: 3,
        retryStrategy: (times) => {
            const delay = Math.min(times * 100, 3000);
            console.log(`[Redis] Reconnecting attempt ${times}, delay ${delay}ms`);
            return delay;
        },
        lazyConnect: false,
        enableReadyCheck: true,
        connectTimeout: 10000,
    });

    client.on('connect', () => console.log('[Redis] Connected successfully.'));
    client.on('ready',   () => console.log('[Redis] Ready to accept commands.'));
    client.on('error',   (err) => console.error('[Redis] Error:', err.message));
    client.on('close',   () => console.warn('[Redis] Connection closed.'));
    client.on('reconnecting', () => console.log('[Redis] Reconnecting...'));

    return client;
}

module.exports = { getRedis };
