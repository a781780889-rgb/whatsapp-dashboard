'use strict';
/**
 * RedisAnalyzer.js — نظام تحليل Redis المتقدم (المرحلة الخامسة)
 *
 * أنماط المفاتيح المُحلَّلة:
 *   rate:{accountId}:{hourTs}      ← Rate Limiting (TTL: 3600)
 *   jwt_blacklist:{token}          ← JWT Blacklist  (TTL: متغير)
 *   socket.io#*                    ← Socket.IO Adapter
 *   bull:{queueName}:*             ← BullMQ Jobs
 *
 * المهام:
 *   1. فحص اتصال Redis والحالة العامة
 *   2. مسح جميع مفاتيح Rate Limiting لكل حساب
 *   3. كشف مفاتيح بدون TTL (memory leak محتمل)
 *   4. تحليل JWT Blacklist (عدد المفاتيح، أكبر TTL متبقٍّ)
 *   5. تحليل BullMQ — jobs معلقة / فاشلة / مكتملة
 *   6. قياس استخدام الذاكرة الكلي وتوزيعه حسب النمط
 *   7. فحص TTL لكل فئة من المفاتيح
 *   8. كشف المفاتيح المنتهية الصلاحية / التالفة
 *   9. تقرير شامل: "Redis سليم / مفاتيح تالفة X / استخدام Y MB"
 */

const { getRedis } = require('../../lib/redis');

// ── أسماء الـ Queues المستخدمة في المشروع ────────────────────────────────
const KNOWN_QUEUES = ['wa-tasks'];

// ── أنماط المفاتيح المعروفة وتصنيفاتها ──────────────────────────────────
const KEY_PATTERNS = {
    rate_limit:   { pattern: 'rate:*',          label: 'Rate Limiting',     expectTTL: true,  expectedMaxTTL: 3600   },
    jwt_blacklist:{ pattern: 'jwt_blacklist:*',  label: 'JWT Blacklist',     expectTTL: true,  expectedMaxTTL: 86400  },
    socket_io:    { pattern: 'socket.io#*',      label: 'Socket.IO Adapter', expectTTL: false, expectedMaxTTL: null   },
    bullmq:       { pattern: 'bull:*',           label: 'BullMQ Jobs',       expectTTL: false, expectedMaxTTL: null   },
};

// ── حدود التحذير ─────────────────────────────────────────────────────────
const THRESHOLDS = {
    MAX_RATE_KEYS_PER_ACCOUNT: 50,   // > 50 مفتاح rate لحساب واحد → تحذير
    MAX_BLACKLIST_KEYS:        5000, // > 5000 مفتاح JWT → تحذير حجم
    MAX_MEMORY_MB:             50,   // > 50 MB استخدام → تحذير
    CRITICAL_MEMORY_MB:        200,  // > 200 MB → حرج
    MAX_FAILED_JOBS:           100,  // > 100 job فاشل → تحذير
    SCAN_BATCH_SIZE:           200,  // عدد المفاتيح لكل SCAN
};

class RedisAnalyzer {

    // ═══════════════════════════════════════════════════════════════════════
    //  مساعد: جلب Redis client مع كشف عدم الاتصال
    // ═══════════════════════════════════════════════════════════════════════

    _getClient() {
        try {
            return { client: getRedis(), error: null };
        } catch (err) {
            return { client: null, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  مساعد: SCAN آمن مع حد أقصى للمفاتيح
    // ═══════════════════════════════════════════════════════════════════════

    async _scanKeys(redis, pattern, maxKeys = 2000) {
        const keys   = [];
        let   cursor = '0';
        do {
            const [nextCursor, batch] = await redis.scan(
                cursor, 'MATCH', pattern, 'COUNT', THRESHOLDS.SCAN_BATCH_SIZE
            );
            cursor = nextCursor;
            keys.push(...batch);
            if (keys.length >= maxKeys) break;
        } while (cursor !== '0');
        return keys;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  1. فحص الاتصال والحالة العامة
    // ═══════════════════════════════════════════════════════════════════════

    async checkConnection() {
        const { client, error } = this._getClient();
        if (!client) {
            return {
                connected: false,
                error,
                status: 'unavailable',
                message: 'Redis غير متاح — تحقق من REDIS_URL',
            };
        }

        try {
            const start  = Date.now();
            await client.ping();
            const pingMs = Date.now() - start;

            // معلومات INFO من Redis
            const infoStr  = await client.info().catch(() => '');
            const infoMap  = this._parseRedisInfo(infoStr);

            const usedMem   = parseInt(infoMap['used_memory']        || 0);
            const peakMem   = parseInt(infoMap['used_memory_peak']   || 0);
            const maxMem    = parseInt(infoMap['maxmemory']          || 0);
            const usedMemMB = Math.round(usedMem / 1024 / 1024 * 100) / 100;
            const peakMemMB = Math.round(peakMem / 1024 / 1024 * 100) / 100;
            const maxMemMB  = maxMem > 0 ? Math.round(maxMem / 1024 / 1024 * 100) / 100 : null;

            const dbSize   = await client.dbsize().catch(() => 0);
            const uptime   = parseInt(infoMap['uptime_in_seconds'] || 0);
            const version  = infoMap['redis_version']  || 'unknown';
            const mode     = infoMap['redis_mode']     || 'standalone';
            const connectedClients = parseInt(infoMap['connected_clients'] || 0);
            const rejectedConns    = parseInt(infoMap['rejected_connections'] || 0);
            const keyspaceHits     = parseInt(infoMap['keyspace_hits']   || 0);
            const keyspaceMisses   = parseInt(infoMap['keyspace_misses'] || 0);
            const hitRate = (keyspaceHits + keyspaceMisses) > 0
                ? Math.round(keyspaceHits / (keyspaceHits + keyspaceMisses) * 100)
                : null;

            const issues = [];

            if (usedMemMB > THRESHOLDS.CRITICAL_MEMORY_MB) {
                issues.push({ severity: 'critical', message: `استخدام ذاكرة حرج: ${usedMemMB} MB` });
            } else if (usedMemMB > THRESHOLDS.MAX_MEMORY_MB) {
                issues.push({ severity: 'warning', message: `استخدام ذاكرة مرتفع: ${usedMemMB} MB` });
            }
            if (rejectedConns > 0) {
                issues.push({ severity: 'warning', message: `${rejectedConns} اتصال(ات) مرفوضة — Redis قد يكون محملاً` });
            }
            if (pingMs > 200) {
                issues.push({ severity: 'warning', message: `تأخر الاستجابة مرتفع: ${pingMs}ms` });
            }

            return {
                connected:        true,
                status:           issues.some(i => i.severity === 'critical') ? 'critical'
                                : issues.some(i => i.severity === 'warning')  ? 'warning'
                                : 'healthy',
                pingMs,
                version,
                mode,
                uptime,
                uptimeHours:      Math.round(uptime / 3600),
                dbSize,
                connectedClients,
                rejectedConns,
                memory: {
                    usedMB:   usedMemMB,
                    peakMB:   peakMemMB,
                    maxMB:    maxMemMB,
                    usagePct: maxMemMB ? Math.round(usedMemMB / maxMemMB * 100) : null,
                },
                cache: {
                    hits:    keyspaceHits,
                    misses:  keyspaceMisses,
                    hitRate: hitRate !== null ? `${hitRate}%` : 'N/A',
                },
                issues,
            };
        } catch (err) {
            return {
                connected: false,
                error:     err.message,
                status:    'error',
                message:   `فشل PING: ${err.message}`,
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. تحليل Rate Limiting لحساب محدد
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeAccountRateKeys(accountId) {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const pattern = `rate:${accountId}:*`;
            const keys    = await this._scanKeys(client, pattern, 200);

            if (keys.length === 0) {
                return {
                    available:   true,
                    accountId,
                    keyCount:    0,
                    keys:        [],
                    status:      'clean',
                    message:     'لا توجد مفاتيح Rate Limiting نشطة لهذا الحساب',
                };
            }

            // جلب TTL لكل مفتاح
            const pipeline = client.pipeline();
            for (const key of keys) {
                pipeline.ttl(key);
                pipeline.get(key);
            }
            const results = await pipeline.exec();

            const keyDetails = keys.map((key, i) => {
                const ttl   = results[i * 2]?.[1];
                const value = results[i * 2 + 1]?.[1];
                // استخراج الـ hour timestamp من المفتاح
                const parts = key.split(':');
                const hourTs = parts[parts.length - 1];
                const hourDate = new Date(parseInt(hourTs) * 3600000).toISOString();
                return {
                    key,
                    hourTimestamp: hourTs,
                    hourDate,
                    count:  parseInt(value || 0),
                    ttl,
                    noTTL: ttl === -1,
                };
            });

            // المفاتيح بدون TTL — memory leak محتمل
            const noTTLKeys = keyDetails.filter(k => k.noTTL);

            const issues = [];
            if (noTTLKeys.length > 0) {
                issues.push({
                    severity: 'warning',
                    code:     'RATE_KEYS_NO_TTL',
                    message:  `${noTTLKeys.length} مفتاح(ات) Rate Limiting بدون TTL — memory leak محتمل`,
                    fix:      'سيتم تنظيفها تلقائياً عند إعادة تشغيل الـ cleanup',
                    keys:     noTTLKeys.map(k => k.key),
                });
            }
            if (keys.length > THRESHOLDS.MAX_RATE_KEYS_PER_ACCOUNT) {
                issues.push({
                    severity: 'warning',
                    code:     'EXCESSIVE_RATE_KEYS',
                    message:  `${keys.length} مفتاح Rate Limiting لحساب واحد — عدد مرتفع`,
                    fix:      'تشغيل cleanup لهذا الحساب',
                });
            }

            const totalMessages = keyDetails.reduce((s, k) => s + k.count, 0);

            return {
                available:     true,
                accountId,
                keyCount:      keys.length,
                keys:          keyDetails,
                totalMessages,
                noTTLCount:    noTTLKeys.length,
                issues,
                status:        issues.some(i => i.severity === 'critical') ? 'critical'
                             : issues.some(i => i.severity === 'warning')  ? 'warning'
                             : 'healthy',
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  3. تحليل Rate Limiting لجميع الحسابات
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeAllRateKeys() {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const allKeys = await this._scanKeys(client, 'rate:*', 5000);

            // تجميع حسب accountId
            const byAccount = {};
            for (const key of allKeys) {
                // format: rate:{accountId}:{hourTs}
                const parts     = key.split(':');
                const accountId = parts.slice(1, -1).join(':'); // يدعم IDs بها :
                if (!byAccount[accountId]) byAccount[accountId] = [];
                byAccount[accountId].push(key);
            }

            // TTL لجميع المفاتيح دفعة واحدة
            const pipeline = client.pipeline();
            for (const key of allKeys) pipeline.ttl(key);
            const ttlResults = await pipeline.exec();

            const noTTLKeys = allKeys.filter((_, i) => ttlResults[i]?.[1] === -1);

            const accountSummary = Object.entries(byAccount).map(([accountId, keys]) => ({
                accountId,
                keyCount: keys.length,
                hasNoTTLKeys: keys.some((k, i) => {
                    const globalIdx = allKeys.indexOf(k);
                    return ttlResults[globalIdx]?.[1] === -1;
                }),
            })).sort((a, b) => b.keyCount - a.keyCount);

            const issues = [];
            if (noTTLKeys.length > 0) {
                issues.push({
                    severity: 'warning',
                    code:     'GLOBAL_RATE_NO_TTL',
                    message:  `${noTTLKeys.length} مفتاح(ات) Rate Limiting بدون TTL على مستوى النظام`,
                    fix:      'تشغيل cleanup أو EXPIRE يدوي على هذه المفاتيح',
                });
            }

            return {
                available:       true,
                totalKeys:       allKeys.length,
                totalAccounts:   Object.keys(byAccount).length,
                noTTLCount:      noTTLKeys.length,
                noTTLKeys:       noTTLKeys.slice(0, 20),
                accountSummary:  accountSummary.slice(0, 50),
                issues,
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  4. تحليل JWT Blacklist
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeJWTBlacklist() {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const keys = await this._scanKeys(client, 'jwt_blacklist:*', 10000);

            if (keys.length === 0) {
                return {
                    available: true,
                    keyCount:  0,
                    status:    'clean',
                    message:   'لا توجد رموز JWT في القائمة السوداء',
                };
            }

            // عينة TTL (أول 100 مفتاح فقط)
            const sample     = keys.slice(0, 100);
            const pipeline   = client.pipeline();
            for (const key of sample) pipeline.ttl(key);
            const ttlResults = await pipeline.exec();

            const ttls    = ttlResults.map(r => r?.[1]).filter(t => t !== null && t !== undefined);
            const noTTL   = ttls.filter(t => t === -1).length;
            const avgTTL  = ttls.filter(t => t > 0).reduce((s, t) => s + t, 0) / (ttls.filter(t => t > 0).length || 1);
            const maxTTL  = Math.max(...ttls.filter(t => t > 0), 0);

            const issues = [];
            if (noTTL > 0) {
                issues.push({
                    severity: 'warning',
                    code:     'JWT_NO_TTL',
                    message:  `${noTTL} رمز JWT في الـ blacklist بدون TTL — memory leak`,
                    fix:      'مراجعة AuthController.logout — يجب تحديد TTL عند إضافة الرمز',
                });
            }
            if (keys.length > THRESHOLDS.MAX_BLACKLIST_KEYS) {
                issues.push({
                    severity: 'warning',
                    code:     'JWT_BLACKLIST_LARGE',
                    message:  `${keys.length} رمز في الـ blacklist — عدد كبير`,
                    fix:      'المفاتيح ذات TTL ستنتهي تلقائياً — لا حاجة لتدخل يدوي عادةً',
                });
            }

            return {
                available:   true,
                keyCount:    keys.length,
                sampleSize:  sample.length,
                noTTLInSample: noTTL,
                avgTTLSeconds: Math.round(avgTTL),
                maxTTLSeconds: maxTTL,
                avgTTLHours:   Math.round(avgTTL / 3600 * 10) / 10,
                issues,
                status: issues.some(i => i.severity === 'critical') ? 'critical'
                      : issues.some(i => i.severity === 'warning')  ? 'warning'
                      : 'healthy',
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  5. تحليل BullMQ Jobs
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeBullMQJobs() {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const queues = {};

            for (const queueName of KNOWN_QUEUES) {
                // أنماط مفاتيح BullMQ v5
                const patterns = [
                    `bull:${queueName}:*`,
                    `${queueName}:*`,
                ];

                let allQueueKeys = [];
                for (const pattern of patterns) {
                    const keys = await this._scanKeys(client, pattern, 2000);
                    allQueueKeys.push(...keys);
                }

                // إزالة المكررات
                allQueueKeys = [...new Set(allQueueKeys)];

                // تصنيف المفاتيح حسب نوعها
                const waiting   = allQueueKeys.filter(k => k.endsWith(':wait') || k.includes(':waiting')).length;
                const active    = allQueueKeys.filter(k => k.includes(':active')).length;
                const completed = allQueueKeys.filter(k => k.includes(':completed')).length;
                const failed    = allQueueKeys.filter(k => k.includes(':failed')).length;
                const delayed   = allQueueKeys.filter(k => k.includes(':delayed')).length;
                const paused    = allQueueKeys.filter(k => k.includes(':paused')).length;

                // محاولة قراءة عدد jobs الفاشلة من sorted sets
                let failedCount  = 0;
                let waitingCount = 0;
                let activeCount  = 0;
                let delayedCount = 0;

                const failedKey  = `bull:${queueName}:failed`;
                const waitKey    = `bull:${queueName}:wait`;
                const activeKey  = `bull:${queueName}:active`;
                const delayedKey = `bull:${queueName}:delayed`;

                try {
                    const [fc, wc, ac, dc] = await Promise.all([
                        client.llen(failedKey).catch(() => client.zcard(failedKey).catch(() => 0)),
                        client.llen(waitKey).catch(() => 0),
                        client.llen(activeKey).catch(() => 0),
                        client.zcard(delayedKey).catch(() => 0),
                    ]);
                    failedCount  = fc || 0;
                    waitingCount = wc || 0;
                    activeCount  = ac || 0;
                    delayedCount = dc || 0;
                } catch { /* ignore */ }

                const issues = [];
                if (failedCount > THRESHOLDS.MAX_FAILED_JOBS) {
                    issues.push({
                        severity: 'warning',
                        code:     'HIGH_FAILED_JOBS',
                        message:  `${failedCount} job فاشل في queue "${queueName}" — يحتاج مراجعة`,
                        fix:      'مراجعة سجل الأخطاء وتشغيل BullMQ retry أو تنظيف الـ failed queue',
                    });
                }
                if (waitingCount > 500) {
                    issues.push({
                        severity: 'warning',
                        code:     'HIGH_WAITING_JOBS',
                        message:  `${waitingCount} job معلق في queue "${queueName}" — الـ queue متأخر`,
                        fix:      'التحقق من حالة الـ Worker وزيادة concurrency إذا لزم',
                    });
                }

                queues[queueName] = {
                    queueName,
                    totalKeys:    allQueueKeys.length,
                    jobCounts: {
                        waiting:  waitingCount,
                        active:   activeCount,
                        failed:   failedCount,
                        delayed:  delayedCount,
                    },
                    issues,
                    status: issues.some(i => i.severity === 'critical') ? 'critical'
                          : issues.some(i => i.severity === 'warning')  ? 'warning'
                          : allQueueKeys.length === 0                   ? 'empty'
                          : 'healthy',
                };
            }

            const allIssues = Object.values(queues).flatMap(q => q.issues);
            return {
                available: true,
                queues,
                allIssues,
                status: allIssues.some(i => i.severity === 'critical') ? 'critical'
                      : allIssues.some(i => i.severity === 'warning')  ? 'warning'
                      : 'healthy',
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  6. كشف المفاتيح بدون TTL (memory leak)
    // ═══════════════════════════════════════════════════════════════════════

    async detectNoTTLKeys() {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const results = {};

            for (const [category, cfg] of Object.entries(KEY_PATTERNS)) {
                if (!cfg.expectTTL) continue; // فقط الفئات التي يجب أن تحمل TTL

                const keys = await this._scanKeys(client, cfg.pattern, 1000);
                if (keys.length === 0) {
                    results[category] = { category, label: cfg.label, keyCount: 0, noTTLCount: 0, noTTLKeys: [] };
                    continue;
                }

                const pipeline = client.pipeline();
                for (const key of keys) pipeline.ttl(key);
                const ttlRes = await pipeline.exec();

                const noTTLKeys = keys.filter((_, i) => ttlRes[i]?.[1] === -1);

                results[category] = {
                    category,
                    label:       cfg.label,
                    keyCount:    keys.length,
                    noTTLCount:  noTTLKeys.length,
                    noTTLPct:    Math.round(noTTLKeys.length / keys.length * 100),
                    noTTLKeys:   noTTLKeys.slice(0, 10), // أول 10 فقط
                    status:      noTTLKeys.length > 0 ? 'warning' : 'healthy',
                };
            }

            const totalNoTTL = Object.values(results).reduce((s, r) => s + r.noTTLCount, 0);

            return {
                available:   true,
                results,
                totalNoTTL,
                status:      totalNoTTL > 0 ? 'warning' : 'healthy',
                message:     totalNoTTL > 0
                    ? `${totalNoTTL} مفتاح(ات) بدون TTL — قد تتراكم وتسبب memory leak`
                    : 'جميع المفاتيح الحساسة تحمل TTL صحيح',
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  7. توزيع الذاكرة حسب نمط المفتاح
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeMemoryDistribution() {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const distribution = {};

            for (const [category, cfg] of Object.entries(KEY_PATTERNS)) {
                const keys = await this._scanKeys(client, cfg.pattern, 500);
                if (keys.length === 0) {
                    distribution[category] = {
                        label:     cfg.label,
                        keyCount:  0,
                        sampleBytes: 0,
                        estimatedKB: 0,
                    };
                    continue;
                }

                // عينة لحساب متوسط الحجم
                const sampleKeys = keys.slice(0, 20);
                let totalBytes   = 0;

                try {
                    const pipeline = client.pipeline();
                    for (const key of sampleKeys) pipeline.debug('object', key);
                    const debugResults = await pipeline.exec().catch(() => []);

                    for (const r of debugResults) {
                        if (r?.[1]) {
                            const match = r[1].toString().match(/serializedlength:(\d+)/);
                            if (match) totalBytes += parseInt(match[1]);
                        }
                    }
                } catch {
                    // fallback: تقدير بناءً على عدد المفاتيح
                    totalBytes = sampleKeys.length * 64;
                }

                const avgBytes      = sampleKeys.length > 0 ? totalBytes / sampleKeys.length : 0;
                const estimatedBytes = avgBytes * keys.length;

                distribution[category] = {
                    label:         cfg.label,
                    keyCount:      keys.length,
                    avgBytesPerKey: Math.round(avgBytes),
                    estimatedKB:   Math.round(estimatedBytes / 1024),
                };
            }

            const totalEstimatedKB = Object.values(distribution)
                .reduce((s, d) => s + d.estimatedKB, 0);

            return {
                available: true,
                distribution,
                totalEstimatedKB,
                totalEstimatedMB: Math.round(totalEstimatedKB / 1024 * 100) / 100,
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  8. تحليل مفاتيح Socket.IO
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeSocketIOKeys() {
        const { client, error } = this._getClient();
        if (!client) return { available: false, error };

        try {
            const keys = await this._scanKeys(client, 'socket.io#*', 1000);

            return {
                available: true,
                keyCount:  keys.length,
                status:    'info',
                message:   `${keys.length} مفتاح Socket.IO (طبيعي — يُدير Adapter الخوادم المتعددة)`,
                sample:    keys.slice(0, 5),
            };
        } catch (err) {
            return { available: false, error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  9. تقرير شامل لـ Redis
    // ═══════════════════════════════════════════════════════════════════════

    async generateFullReport() {
        const startedAt = Date.now();

        const [
            connection,
            rateKeys,
            jwtBlacklist,
            bullmq,
            noTTLKeys,
            memoryDist,
            socketIO,
        ] = await Promise.all([
            this.checkConnection(),
            this.analyzeAllRateKeys(),
            this.analyzeJWTBlacklist(),
            this.analyzeBullMQJobs(),
            this.detectNoTTLKeys(),
            this.analyzeMemoryDistribution(),
            this.analyzeSocketIOKeys(),
        ]);

        // تجميع كل المشكلات
        const allIssues = [
            ...(connection.issues    || []),
            ...(rateKeys.issues      || []),
            ...(jwtBlacklist.issues  || []),
            ...(bullmq.allIssues     || []),
        ];

        if (noTTLKeys.totalNoTTL > 0) {
            allIssues.push({
                severity: 'warning',
                code:     'KEYS_WITHOUT_TTL',
                message:  `${noTTLKeys.totalNoTTL} مفتاح(ات) بدون TTL مكتشفة`,
            });
        }

        const criticalCount = allIssues.filter(i => i.severity === 'critical').length;
        const warningCount  = allIssues.filter(i => i.severity === 'warning').length;

        const overallStatus = !connection.connected ? 'unavailable'
                            : criticalCount > 0     ? 'critical'
                            : warningCount  > 0     ? 'warning'
                            : 'healthy';

        let summaryMessage;
        if (!connection.connected) {
            summaryMessage = `🔴 Redis غير متاح — ${connection.error || 'تعذر الاتصال'}`;
        } else if (overallStatus === 'healthy') {
            summaryMessage = `✅ Redis سليم — ${connection.dbSize} مفتاح، ${connection.memory?.usedMB} MB مستخدم`;
        } else if (overallStatus === 'warning') {
            summaryMessage = `⚠️ Redis يحتوي على ${warningCount} تحذير(ات) — يُنصح بالمراجعة`;
        } else {
            summaryMessage = `🔴 Redis بها ${criticalCount} مشكلة(ات) حرجة تحتاج إجراءً فورياً`;
        }

        const durationMs = Date.now() - startedAt;

        return {
            status:          overallStatus,
            summaryMessage,
            criticalCount,
            warningCount,
            totalIssues:     allIssues.length,
            allIssues,
            durationMs,
            analyzedAt:      new Date().toISOString(),

            connection,
            rateKeys,
            jwtBlacklist,
            bullmq,
            noTTLKeys,
            memoryDistribution: memoryDist,
            socketIO,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  مساعد: تحويل Redis INFO إلى Map
    // ═══════════════════════════════════════════════════════════════════════

    _parseRedisInfo(infoStr) {
        const map = {};
        if (!infoStr) return map;
        for (const line of infoStr.split('\n')) {
            const colon = line.indexOf(':');
            if (colon === -1) continue;
            const key = line.substring(0, colon).trim();
            const val = line.substring(colon + 1).trim();
            map[key] = val;
        }
        return map;
    }
}

module.exports = new RedisAnalyzer();
