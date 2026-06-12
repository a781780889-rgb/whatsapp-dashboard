'use strict';
/**
 * CacheService — طبقة Redis للكاش
 * [FIX-22] المرحلة السادسة — Performance
 *
 * الأهداف:
 *  - تقليل استعلامات DB المتكررة (listAccounts, getGroups, getGroupsByCategory)
 *  - TTL ذكي لكل نوع بيانات
 *  - Namespace Invalidation: مسح كل كاش حساب دفعةً واحدة
 *
 * الاستخدام:
 *   const CacheService = require('./CacheService');
 *
 *   // حفظ
 *   await CacheService.set('accounts:user123', data, 60);   // TTL 60s
 *
 *   // قراءة
 *   const data = await CacheService.get('accounts:user123');
 *
 *   // مسح مفرد
 *   await CacheService.del('accounts:user123');
 *
 *   // مسح بـ prefix (Namespace Invalidation)
 *   await CacheService.delByPrefix('groups:acct-uuid-here');
 */

const { getRedis } = require('./redis');

// ── Prefixes ──────────────────────────────────────────────────────────────────
const PREFIX = {
    ACCOUNTS:    'cache:accounts',       // listAccounts بـ userId
    GROUPS:      'cache:groups',         // getGroups بـ accountId
    CATEGORIES:  'cache:grp_cat',        // getGroupsByCategory بـ accountId
    STATS:       'cache:acct_stats',     // getAccountStats بـ accountId
};

// ── TTL افتراضي (ثواني) ───────────────────────────────────────────────────────
const TTL = {
    ACCOUNTS:   120,  // قائمة الحسابات — تتغير بشكل أبطأ
    GROUPS:      60,  // قائمة المجموعات — قد تتغير بعد sync
    CATEGORIES:  60,  // التصنيفات — نفس المصدر
    STATS:       30,  // إحصائيات سريعة
};

class CacheService {

    // ── get ──────────────────────────────────────────────────────────────────
    /**
     * جلب قيمة من الكاش
     * @returns {any|null} القيمة المُحلَّلة أو null إذا لم توجد
     */
    static async get(key) {
        try {
            const redis = getRedis();
            const raw = await redis.get(`wad:${key}`);
            if (!raw) {
                // [FIX-26] Cache Miss
                try { const ns = key.split(':')[0] || 'default'; require('./MetricsMiddleware').metrics.recordCacheMiss(ns); } catch(_){}
                return null;
            }
            // [FIX-26] Cache Hit
            try { const ns = key.split(':')[0] || 'default'; require('./MetricsMiddleware').metrics.recordCacheHit(ns); } catch(_){}
            return JSON.parse(raw);
        } catch (err) {
            console.error('[CacheService] get error:', err.message);
            return null; // الكاش يفشل بصمت
        }
    }

    // ── set ──────────────────────────────────────────────────────────────────
    /**
     * حفظ قيمة في الكاش
     * @param {string} key
     * @param {any} value
     * @param {number} ttlSeconds
     */
    static async set(key, value, ttlSeconds = 60) {
        try {
            const redis = getRedis();
            await redis.set(`wad:${key}`, JSON.stringify(value), 'EX', ttlSeconds);
        } catch (err) {
            console.error('[CacheService] set error:', err.message);
        }
    }

    // ── del ──────────────────────────────────────────────────────────────────
    /**
     * حذف مفتاح واحد
     */
    static async del(key) {
        try {
            const redis = getRedis();
            await redis.del(`wad:${key}`);
        } catch (err) {
            console.error('[CacheService] del error:', err.message);
        }
    }

    // ── delByPrefix ──────────────────────────────────────────────────────────
    /**
     * مسح كل المفاتيح التي تبدأ بـ prefix معين
     * يُستخدم لـ Namespace Invalidation (مثلاً: كل كاش حساب بعد sync)
     */
    static async delByPrefix(prefix) {
        try {
            const redis = getRedis();
            const pattern = `wad:${prefix}*`;
            let cursor = '0';
            let deleted = 0;
            do {
                const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
                cursor = nextCursor;
                if (keys.length > 0) {
                    await redis.del(...keys);
                    deleted += keys.length;
                }
            } while (cursor !== '0');
            return deleted;
        } catch (err) {
            console.error('[CacheService] delByPrefix error:', err.message);
            return 0;
        }
    }

    // ── Helpers للـ namespaces الشائعة ────────────────────────────────────────

    /** كاش قائمة الحسابات — key بـ userId أو 'admin' */
    static accountsKey(userId)    { return `${PREFIX.ACCOUNTS}:${userId || 'admin'}`; }

    /** كاش مجموعات حساب */
    static groupsKey(accountId)   { return `${PREFIX.GROUPS}:${accountId}`; }

    /** كاش تصنيفات مجموعات حساب */
    static categoriesKey(accountId) { return `${PREFIX.CATEGORIES}:${accountId}`; }

    /** كاش إحصائيات حساب */
    static statsKey(accountId)    { return `${PREFIX.STATS}:${accountId}`; }

    /** مسح كل كاش حساب بعد sync أو تغيير بياناته */
    static async invalidateAccount(accountId) {
        await Promise.all([
            this.del(this.groupsKey(accountId)),
            this.del(this.categoriesKey(accountId)),
            this.del(this.statsKey(accountId)),
        ]);
    }

    /** مسح كاش قائمة الحسابات (بعد إنشاء/حذف حساب) */
    static async invalidateAccountsList() {
        await this.delByPrefix(PREFIX.ACCOUNTS);
    }

    // ── TTL constants (للاستيراد الخارجي) ────────────────────────────────────
    static get TTL() { return TTL; }
}

module.exports = CacheService;
