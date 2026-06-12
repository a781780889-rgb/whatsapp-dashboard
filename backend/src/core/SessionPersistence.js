'use strict';
/**
 * SessionPersistence.js — FIX-12: حفظ حالة الجلسة في Redis واسترجاعها عند restart
 *
 * المشكلة: عند كل restart يبدأ WhatsAppManager من QR جديد حتى لو كانت
 * بيانات المصادقة موجودة في DB. هذا يسبب تجربة سيئة للمستخدمين.
 *
 * الحل:
 *  - عند الاتصال الناجح: نحفظ snapshot للحالة (بدون بيانات حساسة)
 *  - عند الـ restart: نقرأ الـ snapshot ونحدد أي حسابات يجب إعادة تهيئتها
 *  - بيانات المصادقة الفعلية (creds) موجودة في PostgreSQL — نحن نحفظ فقط الـ metadata
 *
 * مخطط Redis:
 *   wa:session:{accountId}    → JSON { accountId, phone, connectedAt, lastSeen, status }
 *   wa:sessions:active        → SET of accountIds
 */

const EventBus = require('./EventBus');

const SESSION_TTL_SEC   = 7 * 24 * 60 * 60;  // 7 أيام
const SESSION_KEY       = (id) => `wa:session:${id}`;
const ACTIVE_SET_KEY    = 'wa:sessions:active';

class SessionPersistence {
    constructor() {
        this._redis = null;
        this._ready = false;
    }

    /**
     * تهيئة الـ redis client (يُستدعى من index.js بعد getRedis())
     */
    init(redisClient) {
        this._redis = redisClient;
        this._ready = !!redisClient;

        if (this._ready) {
            // الاستماع لأحداث EventBus لحفظ الحالة تلقائياً
            EventBus.on('account:connected', ({ accountId, phone }) => {
                this.saveSession(accountId, { phone, status: 'connected' }).catch(() => {});
            });

            EventBus.on('account:disconnected', ({ accountId }) => {
                this.markDisconnected(accountId).catch(() => {});
            });

            EventBus.on('account:deleted', ({ accountId }) => {
                this.deleteSession(accountId).catch(() => {});
            });

            console.log('[SessionPersistence] Initialized and listening to EventBus.');
        } else {
            console.warn('[SessionPersistence] Redis not available — session persistence disabled.');
        }
    }

    // ─── Public API ──────────────────────────────────────────────────────────

    /**
     * حفظ snapshot للجلسة عند الاتصال
     */
    async saveSession(accountId, extra = {}) {
        if (!this._ready) return false;
        try {
            const data = {
                accountId:   String(accountId),
                status:      'connected',
                connectedAt: Date.now(),
                lastSeen:    Date.now(),
                ...extra,
            };
            await this._redis.set(
                SESSION_KEY(accountId),
                JSON.stringify(data),
                'EX', SESSION_TTL_SEC
            );
            await this._redis.sadd(ACTIVE_SET_KEY, String(accountId));
            return true;
        } catch (err) {
            console.error(`[SessionPersistence] saveSession error for ${accountId}:`, err.message);
            return false;
        }
    }

    /**
     * تحديث آخر ظهور للجلسة (keepalive)
     */
    async touch(accountId) {
        if (!this._ready) return false;
        try {
            const raw = await this._redis.get(SESSION_KEY(accountId));
            if (!raw) return false;
            const data = JSON.parse(raw);
            data.lastSeen = Date.now();
            await this._redis.set(SESSION_KEY(accountId), JSON.stringify(data), 'EX', SESSION_TTL_SEC);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * تعليم الجلسة كـ disconnected (دون حذفها — نحتفظ بها للـ restart)
     */
    async markDisconnected(accountId) {
        if (!this._ready) return false;
        try {
            const raw = await this._redis.get(SESSION_KEY(accountId));
            const data = raw ? JSON.parse(raw) : { accountId: String(accountId) };
            data.status       = 'disconnected';
            data.disconnectedAt = Date.now();
            await this._redis.set(SESSION_KEY(accountId), JSON.stringify(data), 'EX', SESSION_TTL_SEC);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * استرجاع بيانات جلسة واحدة
     */
    async getSession(accountId) {
        if (!this._ready) return null;
        try {
            const raw = await this._redis.get(SESSION_KEY(accountId));
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }

    /**
     * الحصول على قائمة الحسابات النشطة (كانت متصلة قبل آخر restart)
     */
    async getActiveSessions() {
        if (!this._ready) return [];
        try {
            const ids = await this._redis.smembers(ACTIVE_SET_KEY);
            return ids || [];
        } catch {
            return [];
        }
    }

    /**
     * حذف جلسة (عند حذف الحساب)
     */
    async deleteSession(accountId) {
        if (!this._ready) return false;
        try {
            await this._redis.del(SESSION_KEY(accountId));
            await this._redis.srem(ACTIVE_SET_KEY, String(accountId));
            return true;
        } catch {
            return false;
        }
    }

    /**
     * استرجاع الحسابات التي كانت متصلة وتحتاج إعادة تهيئة عند الـ restart.
     * يُستدعى من index.js عند بدء التشغيل.
     *
     * @returns {Array<{ accountId, phone, lastSeen }>}
     */
    async getSessionsToRestore() {
        if (!this._ready) return [];
        try {
            const ids      = await this.getActiveSessions();
            const sessions = [];

            for (const id of ids) {
                const session = await this.getSession(id);
                if (!session) continue;

                const age = Date.now() - (session.lastSeen || 0);
                const MAX_AGE_MS = SESSION_TTL_SEC * 1000;

                // لا تُعيد جلسات قديمة جداً
                if (age > MAX_AGE_MS) {
                    await this.deleteSession(id);
                    continue;
                }

                sessions.push({
                    accountId: id,
                    phone:     session.phone || null,
                    lastSeen:  session.lastSeen,
                    status:    session.status,
                });
            }

            return sessions;
        } catch (err) {
            console.error('[SessionPersistence] getSessionsToRestore error:', err.message);
            return [];
        }
    }

    /**
     * إحصاءات عامة
     */
    async getStats() {
        if (!this._ready) return { active: 0, redis: false };
        try {
            const count = await this._redis.scard(ACTIVE_SET_KEY);
            return { active: count || 0, redis: true };
        } catch {
            return { active: 0, redis: false };
        }
    }
}

// Singleton
const persistence = new SessionPersistence();
module.exports = persistence;
