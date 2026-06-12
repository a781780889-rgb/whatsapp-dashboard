'use strict';
/**
 * redis.js — Redis Client Utilities
 *
 * [FIX-18] تم إضافة RedisManager.js كطبقة أعلى لفصل الاتصالات:
 *   - RedisManager.getCache()     → SET/GET/DEL العام
 *   - RedisManager.getPub()       → PUBLISH للـ Socket.IO + EventBus
 *   - RedisManager.getSub()       → SUBSCRIBE للـ Socket.IO + EventBus
 *   - RedisManager.getRateLimit() → عمليات Rate Limiting
 *
 * هذا الملف يحتفظ بـ:
 *   - getRedis()            → backward compatibility (يُعيد cache connection)
 *   - getBullMQConnection() → اتصالات BullMQ المستقلة (لا تزال مطلوبة)
 *
 * ⚠️ BullMQ v5 يشترط صارماً:
 *   - maxRetriesPerRequest: null
 *   - enableReadyCheck: false
 */
const Redis = require('ioredis');

// ── getRedis() — backward compatibility ──────────────────────────────────────
// يُعيد الـ cache connection من RedisManager بدلاً من إنشاء اتصال جديد
function getRedis() {
    try {
        const RedisManager = require('./RedisManager');
        return RedisManager.getCache();
    } catch (_) {
        // Fallback: إذا لم يكن RedisManager متاحاً
        return _getLegacyClient();
    }
}

let _legacyClient = null;
function _getLegacyClient() {
    if (_legacyClient && _legacyClient.status !== 'end') return _legacyClient;
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('[Redis] REDIS_URL is required.');

    _legacyClient = new Redis(url, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        retryStrategy: (times) => Math.min(times * 100, 3000),
        connectTimeout: 10000,
    });
    _legacyClient.on('error', (err) => console.error('[Redis:legacy] Error:', err.message));
    return _legacyClient;
}

// ── getBullMQConnection() — BullMQ-specific ───────────────────────────────────
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
