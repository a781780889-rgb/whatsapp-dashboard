'use strict';
/**
 * index.js — Enterprise WhatsApp SaaS Server
 *
 * التحسينات المُطبَّقة من وثيقة التحليل المعمارية:
 *
 * Section 15.1 — إصلاحات أمنية حرجة:
 * - CORS Whitelist بدلاً من origin: true (كان يسمح لأي Domain).
 * - التحقق من JWT_SECRET عند البدء — Runtime Error إذا لم يُعيَّن.
 *
 * Section 8.3 + 8.2 — Real-time:
 * - Socket.IO + Redis Adapter (يدعم Multi-Process/Multi-Pod).
 * - إزالة global.io Anti-Pattern → Dependency Injection عبر setIO().
 *
 * Section 9.3 — Scheduler:
 * - BullMQ يستبدل Custom Polling Loop.
 *
 * Section 10.3 — Monitoring Phase 1:
 * - pino Structured Logging.
 * - Graceful Shutdown يضمن إتمام المهام الجارية.
 *
 * Section 16.3 — قرارات فورية:
 * - PostgreSQL بدلاً من SQLite.
 * - Redis لـ BullMQ + JWT Blacklist + Socket.IO Adapter.
 */
require('dotenv').config();

// ── ENV Validation (يجب أن تُحدد قبل أي import آخر) ─────────────────────────
function validateEnvironment() {
    const required = ['JWT_SECRET', 'DATABASE_URL', 'REDIS_URL'];
    const missing  = required.filter(k => !process.env[k]);
    if (missing.length > 0) {
        console.error('[STARTUP ERROR] Missing required environment variables:', missing.join(', '));
        console.error('Please set them in your .env file or Railway environment settings.');
        console.error('See .env.example for all required variables.');
        process.exit(1);
    }
    console.log('[ENV] All required environment variables are set.');
}
validateEnvironment();

const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const http       = require('http');
const path       = require('path');
const pino       = require('pino');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');

const { getRedis }       = require('./src/lib/redis');
const DatabaseManager    = require('./src/database/DatabaseManager');
const SystemDB           = require('./src/database/SystemDB');
const WhatsAppManager    = require('./src/bot/WhatsAppManager');
const JobScheduler       = require('./src/scheduler/JobScheduler');
const AccountRoleEngine  = require('./src/api/services/AccountRoleEngine');

// ── Structured Logging — pino (Section 10.3) ─────────────────────────────────
const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    ...(process.env.NODE_ENV !== 'production' ? { transport: { target: 'pino-pretty' } } : {})
});

const app  = express();
const PORT = process.env.PORT || 5000;

// ── Security: Helmet ──────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// ── Trust Proxy (مطلوب على Railway لأنه خلف Reverse Proxy) ───────────────────
app.set('trust proxy', 1);

// ── CORS Whitelist (Section 15.1: كان origin: true — الآن Whitelist محدد) ────
const rawOrigins  = process.env.CORS_ORIGINS || '';
const allowedOrigins = rawOrigins.split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        // Allow non-browser clients (mobile apps, curl, health checks)
        if (!origin) return callback(null, true);
        if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        logger.warn({ origin }, 'CORS: blocked origin');
        callback(new Error(`CORS: Origin ${origin} is not allowed.`));
    },
    credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Rate Limiters ─────────────────────────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    message: { success: false, error: 'عدد كبير من المحاولات، حاول بعد 15 دقيقة.' }
});
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { success: false, error: 'Too many requests.' }
});

// ── Global Error Handlers ─────────────────────────────────────────────────────
process.on('unhandledRejection', (r) => logger.error({ err: r }, '[CRITICAL] Unhandled Rejection'));
process.on('uncaughtException',  (e) => { logger.error({ err: e }, '[CRITICAL] Uncaught Exception'); process.exit(1); });

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authLimiter);
app.use('/api/',        apiLimiter);
app.use('/api/v1',      require('./src/api/routes'));

app.get('/health', async (_, res) => {
    const schedulerStats = await JobScheduler.getStats().catch(() => null);
    res.json({
        status:    'OK',
        uptime:    process.uptime(),
        timestamp: new Date().toISOString(),
        scheduler: schedulerStats,
    });
});

// ── HTTP Server + Socket.IO ───────────────────────────────────────────────────
const server = http.createServer(app);
const io     = new Server(server, {
    cors: {
        origin: (origin, callback) => {
            if (!origin) return callback(null, true);
            if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
                return callback(null, true);
            }
            callback(new Error(`Socket.IO CORS: Origin ${origin} is not allowed.`));
        },
        credentials: true,
    }
});

// ── Socket.IO Redis Adapter (Section 8.3 Phase 1) ────────────────────────────
// يدعم Multi-Process/Multi-Pod deployments على Railway.
// global.io مُزال — نستخدم Dependency Injection.
async function setupSocketIOAdapter() {
    try {
        const pubClient = getRedis();
        const subClient = pubClient.duplicate();
        io.adapter(createAdapter(pubClient, subClient));
        logger.info('[Socket.IO] Redis Adapter configured. Multi-process ready.');
    } catch (err) {
        logger.warn({ err }, '[Socket.IO] Redis Adapter failed — falling back to in-memory.');
    }
}

io.on('connection', (socket) => {
    socket.on('join_account', (accountId) => socket.join(`account_${accountId}`));
});

// ── Static Frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/{*splat}', (_, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function bootstrap() {
    try {
        logger.info('Bootstrapping Enterprise WhatsApp SaaS Platform...');
        logger.info('Architecture: PostgreSQL + Redis + BullMQ + Socket.IO Redis Adapter');

        // 1. Setup Socket.IO Redis Adapter
        await setupSocketIOAdapter();

        // 2. Init PostgreSQL (replaces SQLite)
        await DatabaseManager.init();
        await SystemDB.seedSuperAdmin();

        // 3. Inject Socket.IO into WhatsAppManager (no global.io)
        WhatsAppManager.setIO(io);

        // 4. Init active WhatsApp sessions (using PostgreSQL session storage)
        const active = await SystemDB.all(`SELECT id FROM accounts WHERE status != 'disconnected'`);
        for (const acc of active) {
            await DatabaseManager.getAccountDB(acc.id);
            await WhatsAppManager.initSession(acc.id);
        }

        // 5. Start BullMQ Scheduler (replaces Custom Polling Loop)
        await JobScheduler.start();

        // 6. Start AccountRoleEngine (24/7 background task engine)
        AccountRoleEngine.setDependencies(JobScheduler, WhatsAppManager);
        await AccountRoleEngine.start();

        // 7. Start DatabaseBackupJob
        require('./src/jobs/DatabaseBackupJob').start(24);

        // 8. Start GroupSyncService (مزامنة تلقائية للمجموعات)
        const GroupSyncService = require('./src/api/services/GroupSyncService');
        GroupSyncService.start();

        // 7. Start server
        server.listen(PORT, () => logger.info(`Server running on port ${PORT}`));

        // 8. Graceful Shutdown
        setupGracefulShutdown();

    } catch (err) {
        logger.error({ err }, 'Bootstrap failed');
        process.exit(1);
    }
}

// ── Graceful Shutdown (Section 9.3: لا فقدان مهام عند إعادة النشر) ────────────
function setupGracefulShutdown() {
    const shutdown = async (signal) => {
        logger.info(`[${signal}] Graceful shutdown initiated...`);
        server.close(async () => {
            logger.info('HTTP server closed.');
            AccountRoleEngine.stop();              // Stop role engine
            await JobScheduler.stop();           // Wait for current BullMQ jobs
            require('./src/api/services/GroupSyncService').stop(); // Stop auto-sync
            await DatabaseManager.closeAll();
            logger.info('Shutdown complete.');
            process.exit(0);
        });
        setTimeout(() => { logger.error('Forced shutdown after timeout.'); process.exit(1); }, 30000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap();
