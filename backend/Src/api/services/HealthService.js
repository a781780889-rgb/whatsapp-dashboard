'use strict';
/**
 * HealthService.js — [FIX-25] Deep Health Check System
 *
 * المشكلة قبل الإصلاح:
 *   - لا يوجد endpoint للتحقق من صحة الخدمة
 *   - Railway يُعيد تشغيل الكونتينر فقط عند توقف العملية كلياً
 *   - لا يمكن اكتشاف حالات "zombie" (العملية تعمل لكن Redis أو PostgreSQL معطوب)
 *
 * الحل — نظام فحص صحي متعدد المستويات:
 *
 *   GET /health          → فحص سريع (ping-only) — للـ load balancer
 *   GET /health/deep     → فحص شامل — PostgreSQL + Redis + WhatsApp
 *   GET /health/ready    → هل الخدمة جاهزة لاستقبال الطلبات؟
 *
 * شكل الاستجابة:
 * {
 *   "status": "healthy" | "degraded" | "unhealthy",
 *   "timestamp": "2026-06-12T...",
 *   "uptime": 3600,
 *   "checks": {
 *     "postgres":  { "status": "ok", "ms": 4 },
 *     "redis":     { "status": "ok", "ms": 1 },
 *     "whatsapp":  { "status": "ok", "connected": 3, "total": 5 }
 *   }
 * }
 */

const logger = require('../../core/Logger').child({ module: 'HealthService' });

class HealthService {

    constructor() {
        this._startTime = Date.now();
        this._ready     = false;   // تُصبح true بعد اكتمال Bootstrap
    }

    /** تُستدعى من index.js بعد اكتمال Bootstrap */
    markReady() {
        this._ready = true;
        logger.info('[HealthService] Service marked as ready.');
    }

    /** الوقت المنقضي منذ بدء التشغيل (ثانية) */
    get uptime() {
        return Math.floor((Date.now() - this._startTime) / 1000);
    }

    // ── Liveness: هل العملية حية؟ ────────────────────────────────────────────
    /**
     * فحص بسيط — يُستخدم من قِبَل Railway / Kubernetes liveness probe
     * لا يتصل بأي خدمة خارجية؛ يرد فوراً
     */
    async ping() {
        return {
            status:    'ok',
            timestamp: new Date().toISOString(),
            uptime:    this.uptime,
            service:   process.env.SERVICE_NAME || 'whatsapp-dashboard',
            version:   process.env.npm_package_version || '1.0.0',
        };
    }

    // ── Readiness: هل الخدمة جاهزة؟ ─────────────────────────────────────────
    /**
     * يُستخدم من قِبَل load balancer قبل توجيه الطلبات
     * يرفض الطلبات حتى يكتمل Bootstrap
     */
    async readiness() {
        if (!this._ready) {
            return {
                status:    'starting',
                timestamp: new Date().toISOString(),
                uptime:    this.uptime,
                message:   'Service is still initializing...',
            };
        }
        return {
            status:    'ready',
            timestamp: new Date().toISOString(),
            uptime:    this.uptime,
        };
    }

    // ── Deep Health: فحص شامل ─────────────────────────────────────────────────
    /**
     * يفحص جميع التبعيات الحيوية ويُعيد تقريراً مفصّلاً
     * يستخدم Promise.allSettled حتى يُكمل الفحص حتى لو فشل أحد المكونات
     */
    async deep() {
        const [pgResult, redisResult, waResult] = await Promise.allSettled([
            this._checkPostgres(),
            this._checkRedis(),
            this._checkWhatsApp(),
        ]);

        const checks = {
            postgres:  this._extractResult(pgResult),
            redis:     this._extractResult(redisResult),
            whatsapp:  this._extractResult(waResult),
        };

        // تحديد الحالة الكلية
        const statuses   = Object.values(checks).map(c => c.status);
        const hasError   = statuses.some(s => s === 'error');
        const hasDegraded= statuses.some(s => s === 'degraded');

        const overallStatus = hasError    ? 'unhealthy'
                            : hasDegraded ? 'degraded'
                            : 'healthy';

        const report = {
            status:    overallStatus,
            timestamp: new Date().toISOString(),
            uptime:    this.uptime,
            checks,
        };

        // لوغ حالة غير طبيعية
        if (overallStatus !== 'healthy') {
            logger.warn({ checks: report.checks }, `[HealthService] Status: ${overallStatus}`);
        }

        return report;
    }

    // ── فحص PostgreSQL ────────────────────────────────────────────────────────
    async _checkPostgres() {
        const t0 = Date.now();
        try {
            const { query } = require('../../lib/postgres');
            const res = await Promise.race([
                query('SELECT 1 AS alive'),
                this._timeout(3000, 'PostgreSQL timeout'),
            ]);
            const ms = Date.now() - t0;

            if (!res || res.rows?.[0]?.alive !== 1) {
                return { status: 'error', ms, message: 'Unexpected result from PostgreSQL.' };
            }

            return { status: 'ok', ms };
        } catch (err) {
            return {
                status:  'error',
                ms:      Date.now() - t0,
                message: err.message,
            };
        }
    }

    // ── فحص Redis ────────────────────────────────────────────────────────────
    async _checkRedis() {
        const t0 = Date.now();
        try {
            const RedisManager = require('../../lib/RedisManager');
            const redis = RedisManager.getCache();

            const pong = await Promise.race([
                redis.ping(),
                this._timeout(2000, 'Redis timeout'),
            ]);
            const ms = Date.now() - t0;

            if (pong !== 'PONG') {
                return { status: 'degraded', ms, message: `Unexpected PING response: ${pong}` };
            }

            return { status: 'ok', ms };
        } catch (err) {
            return {
                status:  'error',
                ms:      Date.now() - t0,
                message: err.message,
            };
        }
    }

    // ── فحص WhatsApp ─────────────────────────────────────────────────────────
    async _checkWhatsApp() {
        const t0 = Date.now();
        try {
            const SystemDB = require('../../database/SystemDB');

            // جلب إحصائيات الحسابات مباشرة من DB (أسرع من WhatsAppManager)
            const rows = await Promise.race([
                SystemDB.all(`
                    SELECT
                        COUNT(*)                                         AS total,
                        COUNT(*) FILTER (WHERE status = 'connected')    AS connected,
                        COUNT(*) FILTER (WHERE status = 'disconnected') AS disconnected,
                        COUNT(*) FILTER (WHERE status NOT IN ('connected','disconnected')) AS other
                    FROM accounts
                `),
                this._timeout(3000, 'WhatsApp DB check timeout'),
            ]);

            const ms   = Date.now() - t0;
            const row  = rows?.[0] || {};
            const total       = parseInt(row.total       || 0, 10);
            const connected   = parseInt(row.connected   || 0, 10);
            const disconnected= parseInt(row.disconnected|| 0, 10);
            const other       = parseInt(row.other       || 0, 10);

            // "degraded" إذا لا يوجد حساب واحد متصل (لكن يوجد حسابات)
            const status = (total > 0 && connected === 0) ? 'degraded' : 'ok';

            return { status, ms, total, connected, disconnected, other };
        } catch (err) {
            return {
                status:  'error',
                ms:      Date.now() - t0,
                message: err.message,
            };
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────
    _timeout(ms, msg) {
        return new Promise((_, reject) =>
            setTimeout(() => reject(new Error(msg)), ms)
        );
    }

    _extractResult(settled) {
        if (settled.status === 'fulfilled') return settled.value;
        return { status: 'error', message: settled.reason?.message || 'Unknown error' };
    }
}

module.exports = new HealthService();
