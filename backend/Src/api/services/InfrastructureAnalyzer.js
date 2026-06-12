'use strict';
/**
 * InfrastructureAnalyzer — المرحلة العاشرة
 *
 * مراقبة البنية التحتية الكاملة:
 * - CPU / RAM / Disk للعملية والنظام
 * - صحة PostgreSQL (اتصال + أداء + حجم)
 * - صحة Redis (اتصال + ذاكرة + keys)
 * - BullMQ Queue Stats (waiting / active / completed / failed)
 * - Health Score إجمالي للنظام
 */

const os = require('os');
const { query, queryOne } = require('../../lib/postgres');
const { getRedis } = require('../../lib/redis');

// ── حدود التحذير ──────────────────────────────────────────────────────────────
const THRESHOLDS = {
    cpuUsageWarn:      70,   // %
    cpuUsageCrit:      90,   // %
    memUsageWarn:      75,   // %
    memUsageCrit:      90,   // %
    heapUsageWarn:     70,   // %
    heapUsageCrit:     85,   // %
    pgResponseWarn:    200,  // ms
    pgResponseCrit:    1000, // ms
    redisResponseWarn: 50,   // ms
    redisResponseCrit: 200,  // ms
    pgConnectionsWarn: 80,   // % of max_connections
    pgConnectionsCrit: 95,   // % of max_connections
    bullMQFailedWarn:  50,   // jobs
    bullMQFailedCrit:  200,  // jobs
    diskUsageWarn:     75,   // %
    diskUsageCrit:     90,   // %
};

class InfrastructureAnalyzer {

    // ── 1. Process & System Memory ─────────────────────────────────────────────
    getProcessStats() {
        const mem     = process.memoryUsage();
        const totalMem = os.totalmem();
        const freeMem  = os.freemem();
        const usedMem  = totalMem - freeMem;
        const uptime   = process.uptime();

        const heapUsedMB  = Math.round(mem.heapUsed  / 1024 / 1024);
        const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
        const rssMB       = Math.round(mem.rss       / 1024 / 1024);
        const externalMB  = Math.round(mem.external  / 1024 / 1024);
        const totalMemMB  = Math.round(totalMem / 1024 / 1024);
        const usedMemMB   = Math.round(usedMem  / 1024 / 1024);
        const freeMemMB   = Math.round(freeMem  / 1024 / 1024);

        const heapUsagePct = heapTotalMB > 0 ? Math.round((heapUsedMB / heapTotalMB) * 100) : 0;
        const sysMemPct    = totalMemMB  > 0 ? Math.round((usedMemMB  / totalMemMB)  * 100) : 0;

        return {
            process: {
                pid:         process.pid,
                nodeVersion: process.version,
                platform:    process.platform,
                arch:        process.arch,
                uptimeSeconds: Math.round(uptime),
                uptimeHuman:   this._formatUptime(uptime),
                heapUsedMB,
                heapTotalMB,
                heapUsagePct,
                rssMB,
                externalMB,
            },
            system: {
                totalMemMB,
                usedMemMB,
                freeMemMB,
                sysMemPct,
                cpuCount: os.cpus().length,
                cpuModel: os.cpus()[0]?.model || 'Unknown',
                loadAvg:  os.loadavg().map(v => Math.round(v * 100) / 100),
                hostname: os.hostname(),
                osType:   os.type(),
            }
        };
    }

    // ── 2. CPU Usage (snapshot over 200ms) ────────────────────────────────────
    async getCPUUsage() {
        const cpusBefore = os.cpus();
        await new Promise(r => setTimeout(r, 200));
        const cpusAfter = os.cpus();

        let totalIdle = 0, totalTick = 0;
        for (let i = 0; i < cpusBefore.length; i++) {
            const before = cpusBefore[i].times;
            const after  = cpusAfter[i].times;
            const idle   = after.idle  - before.idle;
            const total  = Object.values(after).reduce((s, v) => s + v, 0)
                         - Object.values(before).reduce((s, v) => s + v, 0);
            totalIdle += idle;
            totalTick += total;
        }
        const usagePct = totalTick > 0
            ? Math.round((1 - totalIdle / totalTick) * 100)
            : 0;

        return {
            usagePct,
            cores:   cpusBefore.length,
            loadAvg: os.loadavg().map(v => Math.round(v * 100) / 100),
        };
    }

    // ── 3. PostgreSQL Health ───────────────────────────────────────────────────
    async getPostgresHealth() {
        const start = Date.now();
        let connected = false;
        let responseMs = null;
        let error = null;
        const details = {};

        try {
            await queryOne('SELECT 1 AS ping');
            responseMs = Date.now() - start;
            connected  = true;

            // إحصائيات الاتصالات
            const connStats = await queryOne(`
                SELECT
                    count(*)::int           AS total_connections,
                    count(*) FILTER (WHERE state = 'active')::int   AS active_connections,
                    count(*) FILTER (WHERE state = 'idle')::int     AS idle_connections,
                    count(*) FILTER (WHERE wait_event IS NOT NULL)::int AS waiting_connections
                FROM pg_stat_activity
                WHERE datname = current_database()
            `);

            // الحد الأقصى للاتصالات
            const maxConn = await queryOne(`SHOW max_connections`);
            const maxConnNum = parseInt(maxConn?.max_connections || '100', 10);
            const connPct = maxConnNum > 0
                ? Math.round(((connStats?.total_connections || 0) / maxConnNum) * 100)
                : 0;

            // حجم قاعدة البيانات
            const dbSize = await queryOne(`
                SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
                       pg_database_size(current_database()) AS size_bytes
            `);

            // أبطأ الاستعلامات (pg_stat_statements إن توفرت)
            let slowQueries = [];
            try {
                const sq = await query(`
                    SELECT query, calls, mean_exec_time::int AS mean_ms, max_exec_time::int AS max_ms
                    FROM pg_stat_statements
                    WHERE mean_exec_time > 100
                    ORDER BY mean_exec_time DESC
                    LIMIT 5
                `);
                slowQueries = sq?.rows || [];
            } catch (_) { /* pg_stat_statements unavailable */ }

            // Lock waits
            const locks = await queryOne(`
                SELECT count(*)::int AS blocked_queries
                FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND datname = current_database()
            `);

            // Table count
            const tableCount = await queryOne(`
                SELECT count(*)::int AS count
                FROM information_schema.tables
                WHERE table_schema = 'public'
            `);

            details.connections = {
                total:    connStats?.total_connections   || 0,
                active:   connStats?.active_connections  || 0,
                idle:     connStats?.idle_connections    || 0,
                waiting:  connStats?.waiting_connections || 0,
                maxAllowed: maxConnNum,
                usagePct:   connPct,
            };
            details.database = {
                name:       process.env.POSTGRES_DB || 'postgres',
                sizePretty: dbSize?.size       || 'N/A',
                sizeBytes:  dbSize?.size_bytes || 0,
                tableCount: tableCount?.count  || 0,
            };
            details.performance = {
                blockedQueries: locks?.blocked_queries || 0,
                slowQueries,
            };

        } catch (err) {
            error = err.message;
            responseMs = Date.now() - start;
        }

        let status = 'healthy';
        const issues = [];

        if (!connected) {
            status = 'critical';
            issues.push({ code: 'PG_DISCONNECTED', severity: 'critical', message: `PostgreSQL غير متصل: ${error}` });
        } else {
            if (responseMs > THRESHOLDS.pgResponseCrit) {
                status = 'critical';
                issues.push({ code: 'PG_SLOW_RESPONSE', severity: 'critical', message: `استجابة PostgreSQL بطيئة جداً: ${responseMs}ms (> ${THRESHOLDS.pgResponseCrit}ms)`, value: responseMs });
            } else if (responseMs > THRESHOLDS.pgResponseWarn) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'PG_SLOW_RESPONSE', severity: 'warning', message: `استجابة PostgreSQL بطيئة: ${responseMs}ms (> ${THRESHOLDS.pgResponseWarn}ms)`, value: responseMs });
            }

            const connPct = details.connections?.usagePct || 0;
            if (connPct > THRESHOLDS.pgConnectionsCrit) {
                status = 'critical';
                issues.push({ code: 'PG_HIGH_CONNECTIONS', severity: 'critical', message: `اتصالات PostgreSQL عالية جداً: ${connPct}%`, value: connPct });
            } else if (connPct > THRESHOLDS.pgConnectionsWarn) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'PG_HIGH_CONNECTIONS', severity: 'warning', message: `اتصالات PostgreSQL مرتفعة: ${connPct}%`, value: connPct });
            }

            if ((details.performance?.blockedQueries || 0) > 0) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'PG_LOCKED_QUERIES', severity: 'warning', message: `يوجد ${details.performance.blockedQueries} استعلام محجوز (Lock wait)`, value: details.performance.blockedQueries });
            }
        }

        return { connected, responseMs, status, issues, details, error };
    }

    // ── 4. Redis Health ────────────────────────────────────────────────────────
    async getRedisHealth() {
        let client;
        try { client = getRedis(); } catch (_) { client = null; }
        if (!client) {
            return {
                connected: false, responseMs: null, status: 'critical',
                issues: [{ code: 'REDIS_NO_CLIENT', severity: 'critical', message: 'Redis client غير مهيأ' }],
                details: {}, error: 'No Redis client'
            };
        }

        const start = Date.now();
        let connected = false;
        let responseMs = null;
        let error = null;
        const details = {};

        try {
            await client.ping();
            responseMs = Date.now() - start;
            connected  = true;

            // INFO memory
            const infoRaw = await client.info('memory');
            const memLines = infoRaw.split('\r\n');
            const getVal = (key) => {
                const line = memLines.find(l => l.startsWith(key + ':'));
                return line ? line.split(':')[1]?.trim() : null;
            };

            const usedMemoryBytes   = parseInt(getVal('used_memory')            || '0', 10);
            const peakMemoryBytes   = parseInt(getVal('used_memory_peak')        || '0', 10);
            const maxMemoryBytes    = parseInt(getVal('maxmemory')               || '0', 10);
            const fragRatio         = parseFloat(getVal('mem_fragmentation_ratio') || '1');
            const usedMemMB  = Math.round(usedMemoryBytes / 1024 / 1024 * 100) / 100;
            const peakMemMB  = Math.round(peakMemoryBytes / 1024 / 1024 * 100) / 100;
            const maxMemMB   = maxMemoryBytes > 0 ? Math.round(maxMemoryBytes / 1024 / 1024 * 100) / 100 : null;
            const memUsagePct = maxMemoryBytes > 0
                ? Math.round((usedMemoryBytes / maxMemoryBytes) * 100)
                : null;

            // INFO server
            const infoServer = await client.info('server');
            const serverLines = infoServer.split('\r\n');
            const getSVal = (key) => {
                const line = serverLines.find(l => l.startsWith(key + ':'));
                return line ? line.split(':')[1]?.trim() : null;
            };
            const redisVersion  = getSVal('redis_version');
            const uptimeSeconds = parseInt(getSVal('uptime_in_seconds') || '0', 10);

            // INFO stats
            const infoStats  = await client.info('stats');
            const statsLines = infoStats.split('\r\n');
            const getSSVal = (key) => {
                const line = statsLines.find(l => l.startsWith(key + ':'));
                return line ? line.split(':')[1]?.trim() : null;
            };
            const totalCmdsProcessed = parseInt(getSSVal('total_commands_processed') || '0', 10);
            const instantOpsPerSec   = parseInt(getSSVal('instantaneous_ops_per_sec') || '0', 10);
            const rejectedConns      = parseInt(getSSVal('rejected_connections')       || '0', 10);
            const keyspaceMisses     = parseInt(getSSVal('keyspace_misses')            || '0', 10);
            const keyspaceHits       = parseInt(getSSVal('keyspace_hits')             || '0', 10);
            const hitRate = (keyspaceHits + keyspaceMisses) > 0
                ? Math.round((keyspaceHits / (keyspaceHits + keyspaceMisses)) * 100)
                : null;

            // Total keys
            const dbInfo = await client.info('keyspace');
            const keyMatch = dbInfo.match(/keys=(\d+)/);
            const totalKeys = keyMatch ? parseInt(keyMatch[1], 10) : 0;

            details.memory = { usedMemMB, peakMemMB, maxMemMB, memUsagePct, fragRatio };
            details.server = { redisVersion, uptimeSeconds, uptimeHuman: this._formatUptime(uptimeSeconds) };
            details.stats  = { totalCmdsProcessed, instantOpsPerSec, rejectedConns, totalKeys, keyspaceHits, keyspaceMisses, hitRate };

        } catch (err) {
            error = err.message;
            responseMs = Date.now() - start;
        }

        let status = 'healthy';
        const issues = [];

        if (!connected) {
            status = 'critical';
            issues.push({ code: 'REDIS_DISCONNECTED', severity: 'critical', message: `Redis غير متصل: ${error}` });
        } else {
            if (responseMs > THRESHOLDS.redisResponseCrit) {
                status = 'critical';
                issues.push({ code: 'REDIS_SLOW', severity: 'critical', message: `استجابة Redis بطيئة جداً: ${responseMs}ms`, value: responseMs });
            } else if (responseMs > THRESHOLDS.redisResponseWarn) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'REDIS_SLOW', severity: 'warning', message: `استجابة Redis بطيئة: ${responseMs}ms`, value: responseMs });
            }

            const memPct = details.memory?.memUsagePct;
            if (memPct !== null && memPct !== undefined) {
                if (memPct > THRESHOLDS.memUsageCrit) {
                    status = 'critical';
                    issues.push({ code: 'REDIS_HIGH_MEM', severity: 'critical', message: `استخدام ذاكرة Redis حرج: ${memPct}%`, value: memPct });
                } else if (memPct > THRESHOLDS.memUsageWarn) {
                    if (status !== 'critical') status = 'warning';
                    issues.push({ code: 'REDIS_HIGH_MEM', severity: 'warning', message: `استخدام ذاكرة Redis مرتفع: ${memPct}%`, value: memPct });
                }
            }

            if ((details.stats?.rejectedConns || 0) > 0) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'REDIS_REJECTED_CONNS', severity: 'warning', message: `Redis رفض ${details.stats.rejectedConns} اتصال`, value: details.stats.rejectedConns });
            }

            const frag = details.memory?.fragRatio;
            if (frag && frag > 1.5) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'REDIS_HIGH_FRAG', severity: 'warning', message: `نسبة تجزؤ ذاكرة Redis مرتفعة: ${frag}`, value: frag });
            }
        }

        return { connected, responseMs, status, issues, details, error };
    }

    // ── 5. BullMQ Stats ────────────────────────────────────────────────────────
    async getBullMQStats() {
        try {
            const JobScheduler = require('../../scheduler/JobScheduler');
            const stats = await JobScheduler.getStats();

            if (!stats) {
                return {
                    available: false,
                    status: 'warning',
                    issues: [{ code: 'BULLMQ_NOT_INIT', severity: 'warning', message: 'BullMQ Queue غير مهيأ' }],
                    stats: null
                };
            }

            const issues = [];
            let status = 'healthy';

            if (stats.failed > THRESHOLDS.bullMQFailedCrit) {
                status = 'critical';
                issues.push({ code: 'BULLMQ_HIGH_FAILED', severity: 'critical', message: `عدد المهام الفاشلة كبير جداً: ${stats.failed}`, value: stats.failed });
            } else if (stats.failed > THRESHOLDS.bullMQFailedWarn) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'BULLMQ_HIGH_FAILED', severity: 'warning', message: `عدد المهام الفاشلة مرتفع: ${stats.failed}`, value: stats.failed });
            }

            if (stats.waiting > 500) {
                if (status !== 'critical') status = 'warning';
                issues.push({ code: 'BULLMQ_HIGH_WAITING', severity: 'warning', message: `قائمة الانتظار كبيرة: ${stats.waiting} مهمة`, value: stats.waiting });
            }

            return { available: true, status, issues, stats };
        } catch (err) {
            return {
                available: false,
                status: 'warning',
                issues: [{ code: 'BULLMQ_ERROR', severity: 'warning', message: `خطأ في قراءة BullMQ: ${err.message}` }],
                stats: null,
                error: err.message
            };
        }
    }

    // ── 6. تقرير الحساب — لا يوجد per-account هنا، لكن نوفر process/system view ─
    async generateSystemReport() {
        const startedAt = Date.now();

        const [processStats, cpuData, pgHealth, redisHealth, bullmqStats] = await Promise.all([
            Promise.resolve(this.getProcessStats()),
            this.getCPUUsage(),
            this.getPostgresHealth(),
            this.getRedisHealth(),
            this.getBullMQStats(),
        ]);

        // احسب Health Score الإجمالي
        const allIssues = [
            ...pgHealth.issues,
            ...redisHealth.issues,
            ...bullmqStats.issues,
        ];

        const criticalCount = allIssues.filter(i => i.severity === 'critical').length;
        const warningCount  = allIssues.filter(i => i.severity === 'warning').length;

        let overallStatus = 'healthy';
        if (criticalCount > 0)     overallStatus = 'critical';
        else if (warningCount > 0) overallStatus = 'warning';

        // Process memory alert
        const heapPct = processStats.process.heapUsagePct;
        const memPct  = processStats.system.sysMemPct;
        if (heapPct > THRESHOLDS.heapUsageCrit) {
            overallStatus = 'critical';
            allIssues.push({ code: 'HIGH_HEAP_USAGE', severity: 'critical', message: `استخدام Heap حرج: ${heapPct}%`, value: heapPct });
        } else if (heapPct > THRESHOLDS.heapUsageWarn) {
            if (overallStatus !== 'critical') overallStatus = 'warning';
            allIssues.push({ code: 'HIGH_HEAP_USAGE', severity: 'warning', message: `استخدام Heap مرتفع: ${heapPct}%`, value: heapPct });
        }

        if (memPct > THRESHOLDS.memUsageCrit) {
            overallStatus = 'critical';
            allIssues.push({ code: 'HIGH_SYS_MEM', severity: 'critical', message: `استخدام ذاكرة النظام حرج: ${memPct}%`, value: memPct });
        } else if (memPct > THRESHOLDS.memUsageWarn) {
            if (overallStatus !== 'critical') overallStatus = 'warning';
            allIssues.push({ code: 'HIGH_SYS_MEM', severity: 'warning', message: `استخدام ذاكرة النظام مرتفع: ${memPct}%`, value: memPct });
        }

        // CPU alert
        if (cpuData.usagePct > THRESHOLDS.cpuUsageCrit) {
            overallStatus = 'critical';
            allIssues.push({ code: 'HIGH_CPU', severity: 'critical', message: `استخدام CPU حرج: ${cpuData.usagePct}%`, value: cpuData.usagePct });
        } else if (cpuData.usagePct > THRESHOLDS.cpuUsageWarn) {
            if (overallStatus !== 'critical') overallStatus = 'warning';
            allIssues.push({ code: 'HIGH_CPU', severity: 'warning', message: `استخدام CPU مرتفع: ${cpuData.usagePct}%`, value: cpuData.usagePct });
        }

        // حساب healthScore (100 - 20*critical - 5*warning)
        const critN = allIssues.filter(i => i.severity === 'critical').length;
        const warnN = allIssues.filter(i => i.severity === 'warning').length;
        const healthScore = Math.max(0, 100 - critN * 20 - warnN * 5);

        return {
            overallStatus,
            healthScore,
            issues: allIssues,
            components: {
                process: {
                    status: this._componentStatus(heapPct, THRESHOLDS.heapUsageWarn, THRESHOLDS.heapUsageCrit),
                    ...processStats,
                    cpu: cpuData,
                },
                postgres: pgHealth,
                redis:    redisHealth,
                bullmq:   bullmqStats,
            },
            analyzedAt: new Date().toISOString(),
            durationMs: Date.now() - startedAt,
        };
    }

    // ── 7. Quick Stats ────────────────────────────────────────────────────────
    async getQuickStats() {
        const processStats = this.getProcessStats();
        const cpu          = await this.getCPUUsage();

        // Quick ping checks
        const pgStart = Date.now();
        let pgOk = false, pgMs = null;
        try { await queryOne('SELECT 1'); pgOk = true; pgMs = Date.now() - pgStart; } catch (_) { pgMs = Date.now() - pgStart; }

        const rdStart = Date.now();
        let rdOk = false, rdMs = null;
        try {
            const client = getRedis();
            if (client) { await client.ping(); rdOk = true; }
            rdMs = Date.now() - rdStart;
        } catch (_) { rdMs = Date.now() - rdStart; }

        let bullmqStats = null;
        try {
            const JobScheduler = require('../../scheduler/JobScheduler');
            bullmqStats = await JobScheduler.getStats();
        } catch (_) {}

        return {
            process: {
                uptime:      processStats.process.uptimeHuman,
                heapUsedMB:  processStats.process.heapUsedMB,
                heapPct:     processStats.process.heapUsagePct,
                rssMB:       processStats.process.rssMB,
                cpuPct:      cpu.usagePct,
                loadAvg:     cpu.loadAvg,
            },
            system: {
                memPct:    processStats.system.sysMemPct,
                freeMemMB: processStats.system.freeMemMB,
                totalMemMB: processStats.system.totalMemMB,
                cpuCores:  processStats.system.cpuCount,
            },
            postgres: { connected: pgOk, responseMs: pgMs },
            redis:    { connected: rdOk, responseMs: rdMs },
            bullmq:   bullmqStats,
        };
    }

    // ── 8. PostgreSQL Table Stats ──────────────────────────────────────────────
    async getPostgresTableStats() {
        try {
            const rows = await query(`
                SELECT
                    relname         AS table_name,
                    n_live_tup      AS live_rows,
                    n_dead_tup      AS dead_rows,
                    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
                    pg_total_relation_size(relid)                 AS total_bytes,
                    last_vacuum,
                    last_autovacuum,
                    last_analyze,
                    last_autoanalyze
                FROM pg_stat_user_tables
                ORDER BY pg_total_relation_size(relid) DESC
                LIMIT 20
            `);
            return rows?.rows || [];
        } catch (err) {
            return [];
        }
    }

    // ── 9. Redis Key Distribution ──────────────────────────────────────────────
    async getRedisKeyDistribution() {
        try {
            let client;
            try { client = getRedis(); } catch (_) { return []; }
            if (!client) return [];

            // أخذ عينة من أول 500 key
            const keys = await client.keys('*');
            const sample = keys.slice(0, 500);

            const dist = {};
            for (const key of sample) {
                const prefix = key.split(':')[0] || 'root';
                dist[prefix] = (dist[prefix] || 0) + 1;
            }

            return Object.entries(dist)
                .map(([prefix, count]) => ({ prefix, count }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 20);
        } catch (_) {
            return [];
        }
    }

    // ── Helpers ────────────────────────────────────────────────────────────────
    _formatUptime(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (d > 0) return `${d}d ${h}h ${m}m`;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }

    _componentStatus(value, warnThresh, critThresh) {
        if (value >= critThresh) return 'critical';
        if (value >= warnThresh) return 'warning';
        return 'healthy';
    }
}

module.exports = new InfrastructureAnalyzer();
