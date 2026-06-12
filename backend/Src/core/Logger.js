'use strict';
/**
 * Logger.js — [FIX-24] Centralized Structured Logging (Pino)
 *
 * المشكلة قبل الإصلاح:
 *   - console.log/warn/error مُبعثَر في كل الملفات
 *   - لا يوجد تنسيق موحّد، لا trace IDs، لا مستويات ديناميكية
 *   - في production لا يمكن تصفية السجلات أو إرسالها لـ log aggregator
 *
 * الحل — Logger.js:
 *   - singleton pino logger يُستورَد بـ require('../core/Logger')
 *   - child() factory لإضافة context (module, accountId, userId)
 *   - HTTP request logger middleware (mixin مع express)
 *   - مستوى اللوغ يُتحكم به عبر LOG_LEVEL (env var)
 *   - في development: pino-pretty ملوّن
 *   - في production: JSON أسطر نقية (مناسب لـ Railway / Datadog / Loki)
 *
 * الاستخدام:
 *   const logger = require('../core/Logger');
 *   logger.info('Server started');
 *   logger.warn({ accountId }, 'Session expired');
 *
 *   // child logger بـ context ثابت
 *   const log = logger.child({ module: 'GroupController' });
 *   log.error({ err }, 'Sync failed');
 *
 *   // HTTP middleware
 *   const { httpLogger } = require('../core/Logger');
 *   app.use(httpLogger);
 */

const pino = require('pino');

// ── التكوين الأساسي ───────────────────────────────────────────────────────────
const isDev        = process.env.NODE_ENV !== 'production';
const level        = process.env.LOG_LEVEL || (isDev ? 'debug' : 'info');
const serviceName  = process.env.SERVICE_NAME || 'whatsapp-dashboard';

/**
 * خيارات Pino المشتركة بين dev وproduction
 */
const baseOptions = {
    level,
    base: {
        service: serviceName,
        env:     process.env.NODE_ENV || 'development',
        pid:     process.pid,
    },
    // حقول التاريخ بتوقيت ISO لسهولة القراءة
    timestamp: pino.stdTimeFunctions.isoTime,
    // تخصيص serializer للـ Error objects
    serializers: {
        err:   pino.stdSerializers.err,
        error: pino.stdSerializers.err,
        req:   pino.stdSerializers.req,
        res:   pino.stdSerializers.res,
    },
    // إخفاء بيانات حساسة
    redact: {
        paths: [
            'password',
            'token',
            'accessToken',
            'refreshToken',
            'authorization',
            'cookie',
            'req.headers.authorization',
            'req.headers.cookie',
        ],
        censor: '[REDACTED]',
    },
};

// ── إنشاء الـ Logger ──────────────────────────────────────────────────────────
let logger;

if (isDev) {
    // Development: pino-pretty مع ألوان
    logger = pino({
        ...baseOptions,
        transport: {
            target:  'pino-pretty',
            options: {
                colorize:           true,
                translateTime:      'SYS:HH:MM:ss.l',
                ignore:             'pid,hostname,service,env',
                messageFormat:      '{msg}',
                singleLine:         false,
            },
        },
    });
} else {
    // Production: JSON نقي — أسرع وأخف (مناسب لـ Railway logs)
    logger = pino(baseOptions);
}

// ── HTTP Request Logger Middleware ────────────────────────────────────────────
/**
 * Express middleware — يُسجّل كل طلب HTTP عند الانتهاء
 *
 * الاستخدام: app.use(httpLogger);
 *
 * النتيجة:
 *   {"method":"GET","url":"/api/v1/accounts","status":200,"ms":12,"ip":"..."}
 */
function httpLogger(req, res, next) {
    const start = Date.now();

    // تسجيل الطلب الوارد (debug فقط — لا يُشبع الـ logs في production)
    logger.debug({
        method: req.method,
        url:    req.originalUrl,
        ip:     req.ip,
    }, '→ request');

    // اعتراض res.end لتسجيل الاستجابة
    const originalEnd = res.end.bind(res);
    res.end = function (...args) {
        const ms      = Date.now() - start;
        const status  = res.statusCode;
        const level   = status >= 500 ? 'error'
                      : status >= 400 ? 'warn'
                      : 'info';

        logger[level]({
            method:  req.method,
            url:     req.originalUrl,
            status,
            ms,
            ip:      req.ip,
            // أضف userId إذا كان موجوداً (من auth middleware)
            ...(req.user?.id ? { userId: req.user.id } : {}),
        }, '← response');

        return originalEnd(...args);
    };

    next();
}

// ── Exports ───────────────────────────────────────────────────────────────────
module.exports             = logger;
module.exports.httpLogger  = httpLogger;

// سهولة الاستخدام: logger.child({ module: 'X' })
// Pino يدعم child() بشكل طبيعي — لا حاجة لـ wrapper
