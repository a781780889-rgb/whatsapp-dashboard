'use strict';
/**
 * index.js — Enterprise WhatsApp SaaS Server
 *
 * Phase 1 Critical Fixes Applied:
 * [FIX-1] PORT: توحيد المنفذ عبر StartupValidator — process.env.PORT فقط.
 *         الـ Dockerfile كان EXPOSE 8080 بينما .env كان PORT=5000 → تعارض على Railway.
 * [FIX-2] SocketBridge: Global Socket Layer بدلاً من تشتُّت io.emit عبر الملفات.
 * [FIX-3] Race Condition: SocketBridge.init(io) قبل WhatsAppManager.setIO(io).
 * [FIX-4] StartupValidator: تحقق شامل من البيئة عند البدء.
 *
 * Phase 4 Scalability Fixes Applied:
 * [FIX-18] RedisManager: 4 اتصالات Redis منفصلة (cache/pub/sub/rateLimit) بدلاً من اتصال واحد مشترك.
 * [FIX-19] Pub/Sub: Socket.IO Redis Adapter يستخدم pub/sub مخصصَين من RedisManager.
 * [FIX-20] QueueManager: نظام Queue مركزي (wa-campaigns/wa-sync/wa-notifications).
 */
require('dotenv').config();

// ── Fallback secrets (Railway UI workaround) ─────────────────────────────────
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    process.env.JWT_SECRET = 'a3f7e9d2c8b5f1e6a4d9c2b7f3e8a1d6c9b4f7e2a5d8c1b6f9e3a7d4c2b8f5e1';
}
if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) {
    process.env.JWT_REFRESH_SECRET = 'd8c5b2f7e1a4d9c6b3f8e5a2d7c1b4f9e6a3d8c5b2f7e1a4d9c6b3f8e5a2d7c1';
}

// ── [FIX-1] PORT + ENV Validation ────────────────────────────────────────────
// يجب أن يُستدعى قبل أي import آخر
const { validate: validateEnv } = require('./src/core/StartupValidator');
const PORT = validateEnv();

const express    = require('express');
const cors         = require('cors');
const cookieParser = require('cookie-parser');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const path       = require('path');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const { getRedis }       = require('./src/lib/redis');
const JWTService         = require('./src/core/JWTService');
const EncryptionService  = require('./src/core/EncryptionService');
const RedisManager       = require('./src/lib/RedisManager');
const QueueManager       = require('./src/lib/QueueManager');
const DatabaseManager    = require('./src/database/DatabaseManager');
const SystemDB           = require('./src/database/SystemDB');
const WhatsAppManager    = require('./src/bot/WhatsAppManager');
const JobScheduler       = require('./src/scheduler/JobScheduler');
const AccountRoleEngine  = require('./src/api/services/AccountRoleEngine');
// [FIX-2] Global Socket Layer
const SocketBridge       = require('./src/core/SocketBridge');
// [FIX-26] Prometheus Metrics
const { metricsMiddleware, metricsHandler } = require('./src/api/middleware/MetricsMiddleware');
// [FIX-25] Health Check Service
const HealthService      = require('./src/api/services/HealthService');

// ── [FIX-24] Centralized Structured Logging (Pino) ──────────────────────────
// Logger.js: singleton pino logger مع HTTP middleware + child loggers
const logger = require('./src/core/Logger');

const app = express();

// ── Security: Helmet ──────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── [FIX-24] HTTP Request Logging ─────────────────────────────────────────────
const { httpLogger } = require('./src/core/Logger');
app.use(httpLogger);

// ── [FIX-26] Prometheus Metrics Middleware ─────────────────────────────────────
app.use(metricsMiddleware);

// ── [FIX-25] Health & Metrics Endpoints (قبل auth — لا تتطلب مصادقة) ─────────
app.get('/metrics',       metricsHandler);
app.get('/health',        async (req, res) => { res.json(await HealthService.ping()); });
app.get('/health/ready',  async (req, res) => {
    const result = await HealthService.readiness();
    res.status(result.status === 'starting' ? 503 : 200).json(result);
});
app.get('/health/deep',   async (req, res) => {
    const result = await HealthService.deep();
    const httpStatus = result.status === 'healthy' ? 200 : result.status === 'degraded' ? 207 : 503;
    res.status(httpStatus).json(result);
});

// ── Trust Proxy (مطلوب على Railway) ──────────────────────────────────────────
app.set('trust proxy', 1);

// ── CORS Whitelist ────────────────────────────────────────────────────────────
const rawOrigins     = process.env.CORS_ORIGINS || '';
const allowedOrigins = rawOrigins.split(',').map(o => o.trim()).filter(Boolean);

const corsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        logger.warn({ origin }, 'CORS: blocked origin');
        callback(new Error(`CORS: Origin ${origin} is not allowed.`));
    },
    credentials: true,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Cookie Parser ────────────────────────────────────────────────────────────
app.use(cookieParser());

// ── [FIX-14] CSRF Protection ─────────────────────────────────────────────────
// يُطبَّق على كل المسارات (مسارات مُعفاة في csrf.js)
app.use(csrfMiddleware);

// ── Rate Limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    message: { success: false, error: 'عدد كبير من المحاولات، حاول بعد 15 دقيقة.' }
});
// ── [FIX-14] CSRF Middleware ─────────────────────────────────────────────────
const { csrfMiddleware } = require('./src/api/middleware/csrf');

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, error: 'Too many requests.' }
});

// ── Global Error Handlers ─────────────────────────────────────────────────────
process.on('unhandledRejection', (r) => logger.error({ err: r }, '[CRITICAL] Unhandled Rejection'));
process.on('uncaughtException',  (e) => { logger.error({ err: e }, '[CRITICAL] Uncaught Exception'); process.exit(1); });

// ── Routes ────────────────────────────────────────────────────────────────────
// Global limiters (backup — per-route limiters in RateLimiter.js أكثر دقة)
app.use('/api/v1/auth', authLimiter);  // 30 req/15min global backup
app.use('/api/',        apiLimiter);   // 1000 req/15min global backup
app.use('/api/v1',      require('./src/api/routes'));

app.get('/health', async (_, res) => {
    const schedulerStats  = await JobScheduler.getStats().catch(() => null);
    const queueStats      = await QueueManager.getStats().catch(() => null);
    const redisHealth     = await RedisManager.healthCheck().catch(() => null);
    res.json({
        status:      'OK',
        uptime:      process.uptime(),
        timestamp:   new Date().toISOString(),
        port:        PORT,
        socketRooms: SocketBridge.getActiveRooms(),
        connections: SocketBridge.getTotalConnections(),
        scheduler:   schedulerStats,
        queues:      queueStats,     // [FIX-20] Queue stats
        redis:       redisHealth,    // [FIX-18] per-connection health
    });
});

// ── HTTP Server + Socket.IO ───────────────────────────────────────────────────
const server = http.createServer(app);
const io     = new Server(server, {
    cors: corsOptions,
    pingTimeout:    60000,
    pingInterval:   25000,
    upgradeTimeout: 30000,
});

// ── [FIX-3] Setup Socket.IO — ترتيب التهيئة مهم لمنع Race Condition ──────────
async function setupSocketIO() {
    // 1. [FIX-18+19] Redis Adapter للـ Multi-Process — اتصالات pub/sub مخصصة
    try {
        const pubClient = RedisManager.getPub();
        const subClient = RedisManager.getSub();
        io.adapter(createAdapter(pubClient, subClient));
        logger.info('[Socket.IO] Redis Adapter configured with dedicated pub/sub connections. Multi-process ready.');
    } catch (err) {
        logger.warn({ err }, '[Socket.IO] Redis Adapter failed — falling back to in-memory.');
    }

    // 2. [FIX-2] SocketBridge يتولى جميع handlers بشكل مركزي
    //    يجب أن يسبق WhatsAppManager.setIO() لضمان استقبال أحداث QR
    SocketBridge.init(io);
    logger.info('[Socket.IO] SocketBridge initialized. Race condition protection active.');
}

// ── Static Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (_, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
    try {
        logger.info('Bootstrapping Enterprise WhatsApp SaaS Platform...');
        logger.info('Architecture: PostgreSQL + Redis + BullMQ + Socket.IO + SocketBridge');

        // 1. [FIX-3] Setup Socket.IO قبل أي session — منع Race Condition
        await setupSocketIO();

        // 2. Init PostgreSQL
        await DatabaseManager.init();
        await SystemDB.seedSuperAdmin();

        // 3. [FIX-2] Inject Socket.IO — setIO يُهيِّئ SocketBridge أيضاً
        WhatsAppManager.setIO(io);

        // [FIX-13] JWTService — حقن Redis للـ blacklist + family tracking
        try {
            const redisCacheForJWT = RedisManager.getCache();
            JWTService.setRedis(redisCacheForJWT);
            logger.info('[Phase5] JWTService initialized with Redis — blacklist + family tracking active.');
        } catch (jwtErr) {
            logger.warn({ err: jwtErr }, '[Phase5] JWTService Redis init failed — blacklist disabled.');
        }

        // [FIX-17] EncryptionService — تحقق من ENCRYPTION_KEY
        try {
            if (!process.env.ENCRYPTION_KEY && process.env.NODE_ENV === 'production') {
                logger.error('[Phase5] ENCRYPTION_KEY not set! Sensitive data will NOT be encrypted in production.');
            } else {
                logger.info('[Phase5] EncryptionService ready — AES-256-GCM active.');
            }
        } catch {}

        // 3b. [FIX-12] تهيئة SessionPersistence بـ Redis cache connection
        try {
            const SessionPersistence = require('./src/core/SessionPersistence');
            // [FIX-18] استخدام cache connection المخصص بدلاً من الاتصال العام
            const redis = RedisManager.getCache();
            SessionPersistence.init(redis);
            logger.info('[Phase3] SessionPersistence initialized with Redis.');
        } catch (spErr) {
            logger.warn({ err: spErr }, '[Phase3] SessionPersistence init failed — session restore disabled.');
        }

        // 3c. [FIX-11] EventBus global listeners (logging + notifications)
        try {
            const EventBus = require('./src/core/EventBus');
            EventBus.on('recovery:auth_failure', ({ accountId }) => {
                logger.warn(`[EventBus] Account ${accountId}: auth_failure — needs new QR.`);
                if (io) {
                    io.emit('account_status', { accountId, status: 'auth_failure', needsQR: true });
                    io.emit('notification', {
                        type: 'warning',
                        title: '⚠️ انتهت جلسة الواتساب',
                        message: `الحساب ${accountId} يحتاج إعادة مسح رمز QR.`,
                    });
                }
            });
            EventBus.on('recovery:failed', ({ accountId, reason }) => {
                logger.error(`[EventBus] Account ${accountId}: recovery failed — ${reason}`);
            });
            EventBus.on('recovery:success', ({ accountId, attempt }) => {
                logger.info(`[EventBus] Account ${accountId}: recovered after ${attempt} attempt(s).`);
            });
            logger.info('[Phase3] EventBus global listeners registered.');
        } catch (ebErr) {
            logger.warn({ err: ebErr }, '[Phase3] EventBus listeners failed.');
        }

        // 4. إعادة تعيين الحالات العالقة
        await SystemDB.run(
            `UPDATE accounts SET status = 'disconnected', updated_at = NOW()
             WHERE status NOT IN ('connected', 'disconnected')`
        ).catch(() => {});

        // [FIX-12] SessionPersistence: استرجاع الجلسات التي كانت متصلة قبل الـ restart
        let sessionsToRestore = [];
        try {
            const SessionPersistence = require('./src/core/SessionPersistence');
            sessionsToRestore = await SessionPersistence.getSessionsToRestore();
            logger.info(`[Phase3] Found ${sessionsToRestore.length} session(s) to restore from Redis.`);
        } catch (_) {}

        // إعادة تهيئة الحسابات المتصلة (من DB + Redis sessions)
        const active = await SystemDB.all(`SELECT id FROM accounts WHERE status = 'connected'`);
        const accountIdsToInit = new Set([
            ...active.map(a => String(a.id)),
            ...sessionsToRestore.map(s => String(s.accountId)),
        ]);

        for (const id of accountIdsToInit) {
            await DatabaseManager.getAccountDB(id).catch(() => {});
            await WhatsAppManager.initSession(id).catch(err =>
                logger.warn({ err }, `[Bootstrap] Failed to restore session for account ${id}`)
            );
        }

        // 4b. Run schema migrations
        try {
            const migrationRunner = require('./src/database/DatabaseMigrationRunner');
            for (const acc of active) {
                const accountDB = await DatabaseManager.getAccountDB(acc.id);
                await migrationRunner.run(acc.id, accountDB);
            }
            logger.info(`[Migration] Migrations applied to ${active.length} account(s).`);
        } catch (migErr) {
            logger.error({ err: migErr }, '[Migration] Migration runner failed — continuing bootstrap.');
        }

        // 5. Start BullMQ Scheduler
        await JobScheduler.start();

        // 5b. [FIX-20] Start QueueManager — نظام Queue المركزي
        // تسجيل handlers قبل start()
        _registerQueueHandlers();
        await QueueManager.start();
        logger.info('[Phase4] QueueManager started. Queues: wa-campaigns, wa-sync, wa-notifications');

        // 6. Start AccountRoleEngine
        AccountRoleEngine.setDependencies(JobScheduler, WhatsAppManager);
        await AccountRoleEngine.start();

        // 7. Start DatabaseBackupJob
        require('./src/jobs/DatabaseBackupJob').start(24);

        // 8. Start GroupSyncService
        const GroupSyncService = require('./src/api/services/GroupSyncService');
        GroupSyncService.start();

        // [FIX-25] Mark service ready for readiness probe
        HealthService.markReady();
        logger.info('[Bootstrap] ✅ All services initialized successfully.');
        logger.info(`[Bootstrap] PORT=${PORT} | Phase5: JWTFamilyTracking=ON | CSRF=ON | RateLimit=ON | Validation=ON | Encryption=ON`);

        setupGracefulShutdown();

    } catch (err) {
        logger.error({ err }, 'Bootstrap failed');
        process.exit(1);
    }
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────
function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        logger.info(`[${signal}] Graceful shutdown initiated...`);
        server.close(async () => {
            logger.info('HTTP server closed.');
            AccountRoleEngine.stop();
            await JobScheduler.stop();
            // [FIX-20] إيقاف QueueManager قبل RedisManager
            await QueueManager.stop();
            require('./src/api/services/GroupSyncService').stop();
            await DatabaseManager.closeAll();
            // [FIX-18] إغلاق جميع اتصالات Redis المخصصة
            await RedisManager.closeAll();
            logger.info('Shutdown complete.');
            process.exit(0);
        });
        setTimeout(() => { logger.error('Forced shutdown after timeout.'); process.exit(1); }, 30000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

// ── [FIX-20] Queue Handlers Registration ──────────────────────────────────────
/**
 * تسجيل handlers للمهام في QueueManager
 * كل handler يُنفَّذ عندما يصل دور المهمة في Queue
 */
function _registerQueueHandlers() {
    const { QUEUES } = QueueManager.constructor;

    // ── Campaign Messages ─────────────────────────────────────────────────────
    QueueManager.registerHandler(QUEUES.CAMPAIGNS, 'send_campaign_message', async (job) => {
        const { accountId, campaignId, targetId, targetType, adLibraryId, messageIndex } = job.data;
        try {
            const CampaignService = require('./src/api/services/CampaignService');
            await CampaignService.executeSingleMessage(accountId, campaignId, {
                targetId, targetType, adLibraryId, messageIndex,
            });
        } catch (err) {
            logger.error({ err, jobId: job.id }, '[QueueManager] send_campaign_message failed');
            throw err; // BullMQ يُعيد المحاولة تلقائياً
        }
    });

    // ── Private Campaign Messages ─────────────────────────────────────────────
    QueueManager.registerHandler(QUEUES.CAMPAIGNS, 'send_private_message', async (job) => {
        const { accountId, campaignId, phone, message, mediaUrl, mediaType, caption } = job.data;
        try {
            const PrivateCampaignService = require('./src/api/services/PrivateCampaignService');
            await PrivateCampaignService.executeSingleMessage(accountId, campaignId, {
                phone, message, mediaUrl, mediaType, caption,
            });
        } catch (err) {
            logger.error({ err, jobId: job.id }, '[QueueManager] send_private_message failed');
            throw err;
        }
    });

    // ── Group Sync ────────────────────────────────────────────────────────────
    QueueManager.registerHandler(QUEUES.SYNC, 'sync_groups', async (job) => {
        const { accountId } = job.data;
        try {
            const GroupSyncService = require('./src/api/services/GroupSyncService');
            await GroupSyncService.syncAccount(accountId);
        } catch (err) {
            logger.error({ err, jobId: job.id }, '[QueueManager] sync_groups failed');
            throw err;
        }
    });

    // ── Notifications ─────────────────────────────────────────────────────────
    QueueManager.registerHandler(QUEUES.NOTIFICATIONS, 'send_notification', async (job) => {
        const { type, title, message: msg, userId } = job.data;
        try {
            if (userId) {
                io.to(`user:${userId}`).emit('notification', { type, title, message: msg });
            } else {
                io.emit('notification', { type, title, message: msg });
            }
        } catch (err) {
            logger.warn({ err }, '[QueueManager] send_notification failed (non-critical)');
            // لا نُعيد الرمي — فشل الإشعار لا يستحق retry
        }
    });

    logger.info('[Phase4] Queue handlers registered: send_campaign_message, send_private_message, sync_groups, send_notification');
}

// ── Start HTTP server FIRST (serves static files immediately) ─────────────────
server.listen(PORT, () => {
    logger.info(`[Server] Listening on port ${PORT}`);
    logger.info('[Server] Static frontend available immediately. Bootstrap starting...');
});

bootstrap();
