'use strict';
/**
 * MetricsMiddleware.js — [FIX-26] Prometheus Metrics
 *
 * المشكلة قبل الإصلاح:
 *   - لا يوجد قياس لأداء الخادم
 *   - لا يمكن اكتشاف تدهور الأداء تلقائياً
 *   - لا يوجد مؤشرات لـ Railway + Grafana
 *
 * الحل — prom-client:
 *   GET /metrics → نص Prometheus بتنسيق exposition
 *
 * المقاييس المُسجَّلة:
 * ┌─────────────────────────────────┬────────────┬──────────────────────────────────┐
 * │ المقياس                        │ النوع      │ الوصف                            │
 * ├─────────────────────────────────┼────────────┼──────────────────────────────────┤
 * │ wad_http_requests_total         │ Counter    │ إجمالي الطلبات (method+route+status) │
 * │ wad_http_request_duration_ms    │ Histogram  │ مدة الطلبات بالمللي ثانية        │
 * │ wad_active_connections          │ Gauge      │ اتصالات HTTP النشطة              │
 * │ wad_whatsapp_connected_accounts │ Gauge      │ حسابات واتساب المتصلة حالياً    │
 * │ wad_whatsapp_messages_sent_total│ Counter    │ الرسائل المُرسَلة إجمالاً        │
 * │ wad_cache_hits_total            │ Counter    │ عدد Cache Hits                   │
 * │ wad_cache_misses_total          │ Counter    │ عدد Cache Misses                 │
 * │ process_cpu_user_seconds_total  │ (default)  │ مقاييس Node.js الافتراضية        │
 * └─────────────────────────────────┴────────────┴──────────────────────────────────┘
 *
 * الاستخدام:
 *   const { metricsMiddleware, metricsHandler } = require('./MetricsMiddleware');
 *
 *   app.use(metricsMiddleware);          // لكل الطلبات
 *   app.get('/metrics', metricsHandler); // endpoint المقاييس
 *
 *   // من أي مكان في الكود:
 *   const { metrics } = require('./MetricsMiddleware');
 *   metrics.recordMessage(accountId);
 *   metrics.recordCacheHit();
 *   metrics.recordCacheMiss();
 *   metrics.setConnectedAccounts(n);
 */

const client  = require('prom-client');
const logger  = require('../../core/Logger').child({ module: 'MetricsMiddleware' });

// ── Registry مخصص (بدلاً من الافتراضي) لتجنب تعارض مع مكتبات أخرى ──────────
const registry = new client.Registry();

// ── إضافة المقاييس الافتراضية لـ Node.js (memory, CPU, event loop, ...) ───────
client.collectDefaultMetrics({
    register:    registry,
    prefix:      'wad_node_',
    gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// ── HTTP Requests Counter ─────────────────────────────────────────────────────
const httpRequestsTotal = new client.Counter({
    name:       'wad_http_requests_total',
    help:       'Total number of HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers:  [registry],
});

// ── HTTP Duration Histogram ───────────────────────────────────────────────────
const httpRequestDuration = new client.Histogram({
    name:       'wad_http_request_duration_ms',
    help:       'HTTP request duration in milliseconds',
    labelNames: ['method', 'route', 'status'],
    buckets:    [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
    registers:  [registry],
});

// ── Active Connections Gauge ──────────────────────────────────────────────────
const activeConnections = new client.Gauge({
    name:      'wad_active_connections',
    help:      'Number of active HTTP connections',
    registers: [registry],
});

// ── WhatsApp Accounts Gauge ───────────────────────────────────────────────────
const connectedAccounts = new client.Gauge({
    name:      'wad_whatsapp_connected_accounts',
    help:      'Number of currently connected WhatsApp accounts',
    registers: [registry],
});

// ── Messages Counter ──────────────────────────────────────────────────────────
const messagesSentTotal = new client.Counter({
    name:       'wad_whatsapp_messages_sent_total',
    help:       'Total WhatsApp messages sent',
    labelNames: ['account_id', 'type'],
    registers:  [registry],
});

// ── Cache Counters ────────────────────────────────────────────────────────────
const cacheHitsTotal = new client.Counter({
    name:       'wad_cache_hits_total',
    help:       'Total Redis cache hits',
    labelNames: ['namespace'],
    registers:  [registry],
});

const cacheMissesTotal = new client.Counter({
    name:       'wad_cache_misses_total',
    help:       'Total Redis cache misses',
    labelNames: ['namespace'],
    registers:  [registry],
});

// ── تطبيع URL لتجنب cardinality عالية في الـ labels ─────────────────────────
/**
 * يحوّل: /api/v1/accounts/abc123/groups → /api/v1/accounts/:id/groups
 * منع explosion في عدد الـ time-series بسبب IDs الديناميكية
 */
function normalizeRoute(url) {
    if (!url) return 'unknown';
    return url
        .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{14,36}/gi, '/:uuid')  // UUIDs
        .replace(/\/\d{10,}/g, '/:id')                                         // Long numeric IDs
        .replace(/\/[a-zA-Z0-9]{20,}/g, '/:id')                               // Long alphanumeric IDs
        .split('?')[0];                                                          // إزالة query params
}

// ── HTTP Middleware ───────────────────────────────────────────────────────────
/**
 * يقيس كل طلب HTTP ويُسجّل:
 *   - wad_http_requests_total
 *   - wad_http_request_duration_ms
 *   - wad_active_connections
 */
function metricsMiddleware(req, res, next) {
    // تجاهل مسار /metrics نفسه لتجنب العد الدائري
    if (req.path === '/metrics') return next();

    activeConnections.inc();
    const timer = httpRequestDuration.startTimer();
    const start = Date.now();

    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
        const route  = normalizeRoute(req.originalUrl || req.url);
        const method = req.method;
        const status = String(res.statusCode);

        // تسجيل المقاييس
        httpRequestsTotal.inc({ method, route, status });
        timer({ method, route, status });
        activeConnections.dec();

        return originalEnd(...args);
    };

    next();
}

// ── /metrics Endpoint Handler ─────────────────────────────────────────────────
/**
 * يُعيد جميع المقاييس بتنسيق Prometheus text exposition
 * يتحقق من مفتاح METRICS_SECRET إذا كان مُعيَّناً
 */
async function metricsHandler(req, res) {
    // حماية اختيارية بـ Bearer token
    const secret = process.env.METRICS_SECRET;
    if (secret) {
        const authHeader = req.headers['authorization'] || '';
        if (authHeader !== `Bearer ${secret}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }

    try {
        // تحديث gauge الحسابات المتصلة من DB قبل الإرسال
        await _refreshConnectedAccountsGauge().catch(() => {});

        const metrics = await registry.metrics();
        res.set('Content-Type', registry.contentType);
        res.end(metrics);
    } catch (err) {
        logger.error({ err }, '[Metrics] Failed to collect metrics');
        res.status(500).json({ error: 'Failed to collect metrics' });
    }
}

// ── تحديث gauge الحسابات المتصلة ─────────────────────────────────────────────
async function _refreshConnectedAccountsGauge() {
    try {
        const SystemDB = require('../../database/SystemDB');
        const rows = await SystemDB.all(
            `SELECT COUNT(*) AS n FROM accounts WHERE status = 'connected'`
        );
        const count = parseInt(rows?.[0]?.n || 0, 10);
        connectedAccounts.set(count);
    } catch (_) {
        // صامت — لا نُفشل /metrics بسبب خطأ في DB
    }
}

// ── Public API لبقية الكود ────────────────────────────────────────────────────
const metrics = {
    /** يُسجَّل عند إرسال رسالة واتساب */
    recordMessage(accountId = 'unknown', type = 'text') {
        messagesSentTotal.inc({ account_id: accountId, type });
    },

    /** يُسجَّل عند Cache Hit */
    recordCacheHit(namespace = 'default') {
        cacheHitsTotal.inc({ namespace });
    },

    /** يُسجَّل عند Cache Miss */
    recordCacheMiss(namespace = 'default') {
        cacheMissesTotal.inc({ namespace });
    },

    /** يُحدَّث مباشرة عند تغيير عدد الحسابات المتصلة */
    setConnectedAccounts(n) {
        connectedAccounts.set(Number(n) || 0);
    },

    /** الوصول للـ registry للاختبارات */
    registry,
};

module.exports = {
    metricsMiddleware,
    metricsHandler,
    metrics,
};
