'use strict';
/**
 * DatabaseAnalyzer.js — نظام تحليل قاعدة البيانات (المرحلة الرابعة)
 *
 * المهام:
 *   1. فحص سلامة session_data (تلف، بيانات يتيمة، مفاتيح مكررة)
 *   2. التحقق من وجود creds + keys:* لكل حساب مرتبط
 *   3. كشف الحالات المتناقضة في جدول accounts
 *   4. فحص subscriptions المنتهية الصلاحية مع status=active
 *   5. تحليل أداء الفهارس (slow queries / missing indexes)
 *   6. كشف تضارب البيانات بين الجداول المترابطة
 *   7. قياس حجم session_data لكل حساب (bloat detection)
 *   8. تقرير شامل: "قاعدة البيانات سليمة / بها مشكلات X"
 */

const { query, queryOne, queryAll } = require('../../lib/postgres');

// ── خطورة المشكلة ─────────────────────────────────────────────────────────
const SEVERITY = {
    CRITICAL: 'critical',   // مشكلة تمنع الاتصال أو تفقد البيانات
    WARNING:  'warning',    // مشكلة تؤثر على الأداء أو تتسبب في سلوك غير متوقع
    INFO:     'info',       // ملاحظة لا تؤثر على الأداء
};

// ── حدود Bloat ────────────────────────────────────────────────────────────
const BLOAT_THRESHOLDS = {
    WARNING_KB:  500,    // > 500 KB لحساب واحد → تحذير
    CRITICAL_KB: 2048,   // > 2 MB  لحساب واحد → حرج
};

// ── الحقول الأساسية التي يجب أن توجد في session_data لأي حساب متصل ────────
const REQUIRED_SESSION_KEYS = ['creds'];
const SIGNAL_KEY_PREFIXES    = ['keys:pre-key:', 'keys:session:', 'keys:sender-key:', 'keys:app-state-sync-key:'];

class DatabaseAnalyzer {

    // ═══════════════════════════════════════════════════════════════════════
    //  1. فحص session_data للحساب المحدد
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * يفحص سلامة session_data لحساب محدد
     * @param {string} accountId
     * @returns {Object} تقرير السلامة
     */
    async analyzeAccountSession(accountId) {
        const issues  = [];
        const details = {};

        // جلب كل صفوف الجلسة لهذا الحساب
        const rows = await queryAll(
            `SELECT key, value, updated_at,
                    octet_length(value::text) as value_bytes
             FROM session_data
             WHERE account_id = $1
             ORDER BY key`,
            [accountId]
        );

        details.totalKeys    = rows.length;
        details.totalSizeKB  = Math.round(rows.reduce((s, r) => s + (parseInt(r.value_bytes) || 0), 0) / 1024);
        details.lastUpdated  = rows.length > 0 ? rows.reduce((a, b) =>
            new Date(a.updated_at) > new Date(b.updated_at) ? a : b).updated_at : null;

        // ── 1a. فحص غياب creds ──────────────────────────────────────────
        const hasCreds = rows.some(r => r.key === 'creds');
        details.hasCreds = hasCreds;
        if (!hasCreds) {
            issues.push({
                severity: SEVERITY.CRITICAL,
                code:     'MISSING_CREDS',
                message:  'مفتاح "creds" غائب — الجلسة ناقصة ولن يتمكن Baileys من الاستعادة',
                fix:      'حذف الجلسة الحالية وإعادة ربط الحساب',
            });
        }

        // ── 1b. فحص صلاحية JSON لكل قيمة ───────────────────────────────
        const corruptedKeys = [];
        for (const row of rows) {
            if (row.value === null || row.value === '') {
                corruptedKeys.push(row.key);
                continue;
            }
            try { JSON.parse(row.value); } catch {
                corruptedKeys.push(row.key);
            }
        }
        details.corruptedKeys = corruptedKeys;
        if (corruptedKeys.length > 0) {
            issues.push({
                severity: SEVERITY.CRITICAL,
                code:     'CORRUPTED_JSON',
                message:  `${corruptedKeys.length} مفتاح/مفاتيح تحتوي على JSON تالف: ${corruptedKeys.slice(0, 5).join(', ')}`,
                fix:      'حذف الجلسة وإعادة الربط — لا يمكن إصلاح JSON تالف',
                affected: corruptedKeys,
            });
        }

        // ── 1c. فحص مفاتيح Signal ────────────────────────────────────────
        const signalKeyCount = {};
        for (const prefix of SIGNAL_KEY_PREFIXES) {
            signalKeyCount[prefix] = rows.filter(r => r.key.startsWith(prefix)).length;
        }
        details.signalKeys = signalKeyCount;

        const totalSignalKeys = Object.values(signalKeyCount).reduce((a, b) => a + b, 0);
        if (hasCreds && totalSignalKeys === 0) {
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'NO_SIGNAL_KEYS',
                message:  'creds موجود لكن لا توجد مفاتيح Signal — قد تفشل رسائل E2E',
                fix:      'الاتصال مرة أولى سيُعيد توليد مفاتيح Signal تلقائياً',
            });
        }

        // ── 1d. فحص Bloat ────────────────────────────────────────────────
        if (details.totalSizeKB > BLOAT_THRESHOLDS.CRITICAL_KB) {
            issues.push({
                severity: SEVERITY.CRITICAL,
                code:     'SESSION_BLOAT_CRITICAL',
                message:  `حجم session_data ضخم جداً: ${details.totalSizeKB} KB — قد يُبطئ عمليات الاستعادة`,
                fix:      'حذف مفاتيح app-state-sync القديمة أو إعادة ربط الحساب',
            });
        } else if (details.totalSizeKB > BLOAT_THRESHOLDS.WARNING_KB) {
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'SESSION_BLOAT_WARNING',
                message:  `حجم session_data كبير: ${details.totalSizeKB} KB`,
                fix:      'مراقبة الحجم — إذا تجاوز 2MB أعد الربط',
            });
        }

        // ── 1e. فحص تحديث قديم ──────────────────────────────────────────
        if (details.lastUpdated) {
            const daysSinceUpdate = (Date.now() - new Date(details.lastUpdated)) / 86400000;
            details.daysSinceLastUpdate = Math.round(daysSinceUpdate);
            if (daysSinceUpdate > 30) {
                issues.push({
                    severity: SEVERITY.WARNING,
                    code:     'STALE_SESSION',
                    message:  `الجلسة لم تُحدَّث منذ ${Math.round(daysSinceUpdate)} يوماً — قد تكون منتهية الصلاحية`,
                    fix:      'تحقق من حالة الحساب وأعد الاتصال إذا لزم',
                });
            }
        }

        // ── حالة إجمالية ─────────────────────────────────────────────────
        const status = issues.some(i => i.severity === SEVERITY.CRITICAL) ? 'critical'
                     : issues.some(i => i.severity === SEVERITY.WARNING)  ? 'warning'
                     : 'healthy';

        return {
            accountId,
            status,
            issueCount: issues.length,
            issues,
            details,
            analyzedAt: new Date().toISOString(),
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. فحص الحالات المتناقضة في جدول accounts
    // ═══════════════════════════════════════════════════════════════════════

    async detectAccountContradictions() {
        const issues = [];

        // حسابات status=connected لكن بدون session_data
        const connectedNoSession = await queryAll(`
            SELECT a.id, a.name, a.phone_number, a.status, a.updated_at
            FROM accounts a
            WHERE a.status = 'connected'
              AND NOT EXISTS (
                  SELECT 1 FROM session_data s
                  WHERE s.account_id = a.id AND s.key = 'creds'
              )
        `).catch(() => []);

        if (connectedNoSession.length > 0) {
            issues.push({
                severity: SEVERITY.CRITICAL,
                code:     'CONNECTED_WITHOUT_SESSION',
                message:  `${connectedNoSession.length} حساب(ات) بحالة "متصل" لكن بدون جلسة مخزنة`,
                fix:      'تحديث حالة الحساب إلى disconnected أو إعادة الاتصال',
                accounts: connectedNoSession.map(a => ({
                    id: a.id, name: a.name, phone: a.phone_number, updatedAt: a.updated_at
                })),
            });
        }

        // حسابات بحالة connected بدون phone_number
        const connectedNoPhone = await queryAll(`
            SELECT id, name, status FROM accounts
            WHERE status = 'connected'
              AND (phone_number IS NULL OR phone_number = '')
        `).catch(() => []);

        if (connectedNoPhone.length > 0) {
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'CONNECTED_WITHOUT_PHONE',
                message:  `${connectedNoPhone.length} حساب(ات) متصلة بدون رقم هاتف مسجّل`,
                fix:      'تحديث phone_number من بيانات الجلسة',
                accounts: connectedNoPhone.map(a => ({ id: a.id, name: a.name })),
            });
        }

        // حسابات user_id يشير لمستخدم غير موجود (orphan accounts)
        const orphanAccounts = await queryAll(`
            SELECT a.id, a.name, a.user_id FROM accounts a
            WHERE a.user_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = a.user_id)
        `).catch(() => []);

        if (orphanAccounts.length > 0) {
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'ORPHAN_ACCOUNTS',
                message:  `${orphanAccounts.length} حساب(ات) مرتبطة بمستخدمين محذوفين`,
                fix:      'UPDATE accounts SET user_id = NULL WHERE user_id NOT IN (SELECT id FROM users)',
                accounts: orphanAccounts.map(a => ({ id: a.id, name: a.name, userId: a.user_id })),
            });
        }

        // session_data يتيمة (account_id غير موجود في accounts)
        const orphanSessions = await queryAll(`
            SELECT DISTINCT s.account_id,
                   COUNT(*) as key_count,
                   SUM(octet_length(s.value::text)) as total_bytes
            FROM session_data s
            WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = s.account_id)
            GROUP BY s.account_id
        `).catch(() => []);

        if (orphanSessions.length > 0) {
            const totalKB = Math.round(orphanSessions.reduce((s, r) => s + parseInt(r.total_bytes || 0), 0) / 1024);
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'ORPHAN_SESSION_DATA',
                message:  `${orphanSessions.length} مجموعة session_data يتيمة تشغل ${totalKB} KB`,
                fix:      'DELETE FROM session_data WHERE account_id NOT IN (SELECT id FROM accounts)',
                sessions: orphanSessions.map(s => ({
                    accountId: s.account_id,
                    keyCount:  parseInt(s.key_count),
                    sizeKB:    Math.round(parseInt(s.total_bytes || 0) / 1024),
                })),
            });
        }

        return {
            contradictionCount: issues.length,
            issues,
            summary: {
                connectedWithoutSession: connectedNoSession.length,
                connectedWithoutPhone:   connectedNoPhone.length,
                orphanAccounts:          orphanAccounts.length,
                orphanSessions:          orphanSessions.length,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  3. فحص الاشتراكات المتناقضة
    // ═══════════════════════════════════════════════════════════════════════

    async detectSubscriptionContradictions() {
        const issues = [];

        // اشتراكات status=active لكن expires_at في الماضي
        const expiredActive = await queryAll(`
            SELECT s.id, s.user_id, s.plan_type, s.expires_at,
                   u.username
            FROM subscriptions s
            LEFT JOIN users u ON u.id = s.user_id
            WHERE s.status = 'active'
              AND s.expires_at IS NOT NULL
              AND s.expires_at < NOW()
        `).catch(() => []);

        if (expiredActive.length > 0) {
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'EXPIRED_BUT_ACTIVE',
                message:  `${expiredActive.length} اشتراك(ات) منتهية الصلاحية لكن status=active`,
                fix:      'تشغيل SystemDB.expireStaleSubscriptions() لتحديث الحالة',
                subscriptions: expiredActive.map(s => ({
                    id:        s.id,
                    userId:    s.user_id,
                    username:  s.username,
                    planType:  s.plan_type,
                    expiresAt: s.expires_at,
                })),
            });
        }

        // مستخدمون بدون اشتراك أصلاً
        const usersNoSub = await queryAll(`
            SELECT u.id, u.username, u.role, u.created_at
            FROM users u
            WHERE NOT EXISTS (
                SELECT 1 FROM subscriptions s WHERE s.user_id = u.id
            )
            AND u.role NOT IN ('superadmin', 'super_admin', 'owner', 'admin')
        `).catch(() => []);

        if (usersNoSub.length > 0) {
            issues.push({
                severity: SEVERITY.INFO,
                code:     'USERS_WITHOUT_SUBSCRIPTION',
                message:  `${usersNoSub.length} مستخدم(ين) بدون أي سجل اشتراك`,
                fix:      'إنشاء اشتراك لهم أو التحقق من منطق التسجيل',
                users: usersNoSub.map(u => ({ id: u.id, username: u.username, role: u.role })),
            });
        }

        // اشتراكات يتيمة (user_id غير موجود)
        const orphanSubs = await queryAll(`
            SELECT s.id, s.user_id, s.status, s.plan_type FROM subscriptions s
            WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)
        `).catch(() => []);

        if (orphanSubs.length > 0) {
            issues.push({
                severity: SEVERITY.WARNING,
                code:     'ORPHAN_SUBSCRIPTIONS',
                message:  `${orphanSubs.length} اشتراك(ات) يتيمة لمستخدمين محذوفين`,
                fix:      'DELETE FROM subscriptions WHERE user_id NOT IN (SELECT id FROM users)',
                subscriptions: orphanSubs.map(s => ({ id: s.id, userId: s.user_id, planType: s.plan_type })),
            });
        }

        return {
            contradictionCount: issues.length,
            issues,
            summary: {
                expiredButActive:    expiredActive.length,
                usersWithoutSub:     usersNoSub.length,
                orphanSubscriptions: orphanSubs.length,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  4. تحليل Bloat لـ session_data
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeSessionBloat() {
        const rows = await queryAll(`
            SELECT
                s.account_id,
                a.name        as account_name,
                a.status      as account_status,
                COUNT(*)      as key_count,
                SUM(octet_length(s.value::text))  as total_bytes,
                MAX(s.updated_at)                 as last_updated,
                COUNT(CASE WHEN s.key = 'creds' THEN 1 END) as has_creds,
                COUNT(CASE WHEN s.key LIKE 'keys:%' THEN 1 END) as signal_key_count
            FROM session_data s
            LEFT JOIN accounts a ON a.id = s.account_id
            GROUP BY s.account_id, a.name, a.status
            ORDER BY total_bytes DESC
        `).catch(() => []);

        const bloatCritical = [];
        const bloatWarning  = [];
        const healthy       = [];

        for (const row of rows) {
            const sizeKB = Math.round(parseInt(row.total_bytes || 0) / 1024);
            const entry  = {
                accountId:      row.account_id,
                accountName:    row.account_name || 'محذوف',
                accountStatus:  row.account_status || 'unknown',
                keyCount:       parseInt(row.key_count),
                sizeKB,
                hasCreds:       parseInt(row.has_creds) > 0,
                signalKeyCount: parseInt(row.signal_key_count),
                lastUpdated:    row.last_updated,
            };
            if (sizeKB > BLOAT_THRESHOLDS.CRITICAL_KB) bloatCritical.push(entry);
            else if (sizeKB > BLOAT_THRESHOLDS.WARNING_KB) bloatWarning.push(entry);
            else healthy.push(entry);
        }

        const totalSizeKB = rows.reduce((s, r) => s + Math.round(parseInt(r.total_bytes || 0) / 1024), 0);

        return {
            totalAccounts:   rows.length,
            totalSizeKB,
            totalSizeMB:     Math.round(totalSizeKB / 1024 * 100) / 100,
            bloatCritical,
            bloatWarning,
            healthy,
            thresholds: {
                warningKB:  BLOAT_THRESHOLDS.WARNING_KB,
                criticalKB: BLOAT_THRESHOLDS.CRITICAL_KB,
            },
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  5. تحليل أداء الفهارس والاستعلامات
    // ═══════════════════════════════════════════════════════════════════════

    async analyzePerformance() {
        const results = {};

        // ── جمع إحصائيات pg_stat_user_tables ────────────────────────────
        const tableStats = await queryAll(`
            SELECT
                relname        as table_name,
                n_live_tup     as live_rows,
                n_dead_tup     as dead_rows,
                last_vacuum,
                last_autovacuum,
                last_analyze,
                last_autoanalyze,
                seq_scan,
                idx_scan,
                CASE WHEN (seq_scan + idx_scan) = 0 THEN 0
                     ELSE ROUND(idx_scan::numeric / (seq_scan + idx_scan) * 100, 1)
                END as idx_hit_pct
            FROM pg_stat_user_tables
            ORDER BY live_rows DESC
        `).catch(() => []);

        results.tableStats = tableStats;

        // ── كشف الجداول ذات Sequential Scans عالية ──────────────────────
        const highSeqScan = tableStats.filter(t =>
            parseInt(t.seq_scan) > 100 && parseFloat(t.idx_hit_pct) < 80
        );
        results.highSeqScanTables = highSeqScan.map(t => ({
            table:      t.table_name,
            liveRows:   parseInt(t.live_rows),
            seqScans:   parseInt(t.seq_scan),
            idxHitPct:  parseFloat(t.idx_hit_pct),
            message:    `نسبة استخدام الفهارس ${t.idx_hit_pct}% فقط — يُنصح بمراجعة الفهارس`,
        }));

        // ── جمع إحصائيات pg_stat_user_indexes ───────────────────────────
        const indexStats = await queryAll(`
            SELECT
                indexrelname as index_name,
                relname      as table_name,
                idx_scan     as scans,
                idx_tup_read as tuples_read
            FROM pg_stat_user_indexes
            ORDER BY idx_scan DESC
        `).catch(() => []);

        results.indexStats = indexStats;

        // فهارس لم تُستخدم أبداً (scans = 0)
        const unusedIndexes = indexStats.filter(i =>
            parseInt(i.scans) === 0 && !i.index_name.includes('_pkey')
        );
        results.unusedIndexes = unusedIndexes.map(i => ({
            index: i.index_name, table: i.table_name,
            message: 'لم يُستخدم هذا الفهرس منذ إنشاء قاعدة البيانات',
        }));

        // ── حجم الجداول ─────────────────────────────────────────────────
        const tableSizes = await queryAll(`
            SELECT
                tablename  as table_name,
                pg_size_pretty(pg_total_relation_size(quote_ident(tablename))) as total_size,
                pg_total_relation_size(quote_ident(tablename)) as total_bytes
            FROM pg_tables
            WHERE schemaname = 'public'
            ORDER BY total_bytes DESC
        `).catch(() => []);

        results.tableSizes = tableSizes;

        // ── dead rows (بحاجة لـ VACUUM) ──────────────────────────────────
        const needsVacuum = tableStats.filter(t =>
            parseInt(t.dead_rows) > 1000 ||
            (parseInt(t.live_rows) > 0 && parseInt(t.dead_rows) / parseInt(t.live_rows) > 0.1)
        );
        results.needsVacuum = needsVacuum.map(t => ({
            table:    t.table_name,
            liveRows: parseInt(t.live_rows),
            deadRows: parseInt(t.dead_rows),
            message:  `${t.dead_rows} صف ميت — يُنصح بتشغيل VACUUM`,
        }));

        // ── pg_stat_statements (إذا متاح) ───────────────────────────────
        const slowQueries = await queryAll(`
            SELECT
                SUBSTRING(query, 1, 120) as query_preview,
                calls,
                ROUND(mean_exec_time::numeric, 2) as avg_ms,
                ROUND(total_exec_time::numeric, 2) as total_ms
            FROM pg_stat_statements
            WHERE mean_exec_time > 100
              AND query NOT LIKE '%pg_stat%'
            ORDER BY mean_exec_time DESC
            LIMIT 10
        `).catch(() => null);

        results.slowQueriesAvailable = slowQueries !== null;
        results.slowQueries          = slowQueries || [];

        return results;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  6. تقرير شامل لقاعدة البيانات
    // ═══════════════════════════════════════════════════════════════════════

    async generateFullReport() {
        const startedAt = Date.now();

        const [
            accountContradictions,
            subscriptionContradictions,
            bloatReport,
            performance,
        ] = await Promise.all([
            this.detectAccountContradictions(),
            this.detectSubscriptionContradictions(),
            this.analyzeSessionBloat(),
            this.analyzePerformance(),
        ]);

        // جمع إحصائيات سريعة
        const stats = await this._gatherStats();

        // تجميع جميع المشكلات
        const allIssues = [
            ...accountContradictions.issues,
            ...subscriptionContradictions.issues,
        ];

        const criticalCount = allIssues.filter(i => i.severity === SEVERITY.CRITICAL).length
            + bloatReport.bloatCritical.length;
        const warningCount  = allIssues.filter(i => i.severity === SEVERITY.WARNING).length
            + bloatReport.bloatWarning.length
            + performance.needsVacuum?.length || 0;
        const infoCount     = allIssues.filter(i => i.severity === SEVERITY.INFO).length;

        const overallStatus = criticalCount > 0 ? 'critical'
                            : warningCount  > 0 ? 'warning'
                            : 'healthy';

        const durationMs = Date.now() - startedAt;

        // رسالة الملخص
        let summaryMessage;
        if (overallStatus === 'healthy') {
            summaryMessage = '✅ قاعدة البيانات سليمة — لا توجد مشكلات تحتاج تدخلاً';
        } else if (overallStatus === 'warning') {
            summaryMessage = `⚠️ قاعدة البيانات تحتوي على ${warningCount} تحذير(ات) — يُنصح بالمراجعة`;
        } else {
            summaryMessage = `🔴 قاعدة البيانات بها ${criticalCount} مشكلة(ات) حرجة تحتاج إجراءً فورياً`;
        }

        return {
            status:         overallStatus,
            summaryMessage,
            criticalCount,
            warningCount,
            infoCount,
            totalIssues:    criticalCount + warningCount + infoCount,
            durationMs,
            analyzedAt:     new Date().toISOString(),

            stats,
            accountContradictions,
            subscriptionContradictions,
            bloatReport,
            performance,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  7. إحصائيات سريعة لنظرة عامة
    // ═══════════════════════════════════════════════════════════════════════

    async _gatherStats() {
        const [
            accounts, users, subscriptions,
            sessionRows, diagnostics, attempts,
        ] = await Promise.all([
            queryOne(`SELECT COUNT(*) as cnt FROM accounts`).catch(() => ({ cnt: 0 })),
            queryOne(`SELECT COUNT(*) as cnt FROM users`).catch(() => ({ cnt: 0 })),
            queryOne(`SELECT COUNT(*) as cnt FROM subscriptions WHERE status='active'`).catch(() => ({ cnt: 0 })),
            queryOne(`SELECT COUNT(*) as cnt, COUNT(DISTINCT account_id) as accounts FROM session_data`).catch(() => ({ cnt: 0, accounts: 0 })),
            queryOne(`SELECT COUNT(*) as cnt FROM connection_diagnostics`).catch(() => ({ cnt: 0 })),
            queryOne(`SELECT COUNT(*) as cnt FROM connection_attempts`).catch(() => ({ cnt: 0 })),
        ]);

        const connectedAccounts = await queryOne(
            `SELECT COUNT(*) as cnt FROM accounts WHERE status='connected'`
        ).catch(() => ({ cnt: 0 }));

        const sessionSizeRow = await queryOne(
            `SELECT SUM(octet_length(value::text)) as total_bytes FROM session_data`
        ).catch(() => ({ total_bytes: 0 }));

        return {
            accounts:           parseInt(accounts.cnt),
            connectedAccounts:  parseInt(connectedAccounts.cnt),
            users:              parseInt(users.cnt),
            activeSubscriptions:parseInt(subscriptions.cnt),
            sessionKeys:        parseInt(sessionRows.cnt),
            sessionAccounts:    parseInt(sessionRows.accounts),
            sessionSizeKB:      Math.round(parseInt(sessionSizeRow?.total_bytes || 0) / 1024),
            diagnosticsRecords: parseInt(diagnostics.cnt),
            connectionAttempts: parseInt(attempts.cnt),
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  8. فحص سريع لحساب محدد + تحقق من session keys
    // ═══════════════════════════════════════════════════════════════════════

    async quickAccountCheck(accountId) {
        const [sessionReport, accountRow] = await Promise.all([
            this.analyzeAccountSession(accountId),
            queryOne(
                `SELECT id, name, phone_number, status, health_status,
                        connection_type, warmup_phase, last_activity_at, updated_at
                 FROM accounts WHERE id = $1`,
                [accountId]
            ).catch(() => null),
        ]);

        if (!accountRow) {
            return {
                accountId,
                found: false,
                status: 'not_found',
                message: 'الحساب غير موجود في قاعدة البيانات',
            };
        }

        // فحص التناقض: status=connected بدون creds
        const contradiction = accountRow.status === 'connected' && !sessionReport.details.hasCreds;

        return {
            accountId,
            found: true,
            account: {
                name:           accountRow.name,
                phone:          accountRow.phone_number,
                status:         accountRow.status,
                healthStatus:   accountRow.health_status,
                connectionType: accountRow.connection_type,
                inWarmup:       accountRow.warmup_phase,
                lastActivity:   accountRow.last_activity_at,
            },
            session: sessionReport,
            contradiction,
            contradictionMessage: contradiction
                ? '⚠️ الحساب يظهر كمتصل لكن لا توجد جلسة — يحتاج إعادة اتصال'
                : null,
        };
    }
}

module.exports = new DatabaseAnalyzer();
