'use strict';
/**
 * SessionAnalyzer.js — تحليل الجلسات المتعمق (المرحلة السادسة)
 *
 * مهام هذه الوحدة:
 *   1. تحليل بيانات `creds` المخزنة (دون كشف مفاتيح حساسة)
 *   2. مقارنة إصدار credentials مع إصدار Baileys الحالي
 *   3. فحص سلامة Signal Keys: pre-key، session، sender-key، app-state-sync-key
 *   4. كشف الجلسات التالفة (تشفير خاطئ أو بيانات مبتورة أو JSON فاسد)
 *   5. تقييم قابلية استعادة الجلسة
 *   6. كشف الجلسات القديمة (أكثر من 30 يوم بدون نشاط)
 *   7. تقرير نهائي: "سليمة / قابلة للاستعادة / يجب إعادة الربط"
 *
 * مصدر البيانات: جدول session_data (PostgreSQL)
 *   account_id | key                      | value | updated_at
 *   -----------|--------------------------|-------|-------------
 *   <uuid>     | creds                    | JSON  | timestamp
 *   <uuid>     | keys:pre-key:<id>        | JSON  | timestamp
 *   <uuid>     | keys:session:<id>        | JSON  | timestamp
 *   <uuid>     | keys:sender-key:<id>     | JSON  | timestamp
 *   <uuid>     | keys:app-state-sync-key:<id> | JSON | timestamp
 */

const { queryAll, queryOne, query } = require('../../lib/postgres');

// ── حدود التحذير ──────────────────────────────────────────────────────────
const THRESHOLDS = {
    STALE_DAYS:              30,    // جلسة بدون نشاط > 30 يوم → قديمة
    MIN_PRE_KEYS:            5,     // أقل من 5 pre-keys → تحذير
    MAX_PRE_KEYS:            200,   // أكثر من 200 pre-key → bloat
    MAX_SESSION_KEYS:        500,   // أكثر من 500 session key → bloat
    MAX_SENDER_KEYS:         300,   // أكثر من 300 sender-key → bloat
    SAMPLE_SIZE:             10,    // عدد المفاتيح للفحص العشوائي
    LARGE_CREDS_BYTES:       50000, // creds > 50KB → تحذير حجم
};

// ── حقول creds المتوقعة في Baileys ───────────────────────────────────────
const EXPECTED_CREDS_FIELDS = [
    'noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey',
    'signedPreKey', 'registrationId', 'advSecretKey', 'me',
    'account', 'signalIdentities', 'platform', 'processedHistoryMessages',
    'nextPreKeyId', 'firstUnuploadedPreKeyId', 'accountSyncCounter',
];

// الحقول الإلزامية لجلسة مكتملة
const REQUIRED_CREDS_FIELDS = [
    'noiseKey', 'signedIdentityKey', 'signedPreKey',
    'registrationId', 'me', 'account',
];

// الحقول الحساسة — لا تُرسَل في الاستجابة أبداً
const SENSITIVE_FIELDS = [
    'noiseKey', 'pairingEphemeralKeyPair', 'signedIdentityKey',
    'signedPreKey', 'advSecretKey', 'signalIdentities',
];

class SessionAnalyzer {

    // ═══════════════════════════════════════════════════════════════════════
    //  1. تحليل creds لحساب محدد
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeCredentials(accountId) {
        const issues = [];
        const result = {
            accountId,
            hasCreds:        false,
            credsSize:       0,
            isRegistered:    false,
            phoneNumber:     null,
            platform:        null,
            nextPreKeyId:    null,
            missingFields:   [],
            extraFields:     [],
            sizeWarning:     false,
            lastUpdated:     null,
            ageHours:        null,
            issues,
        };

        try {
            const row = await queryOne(
                `SELECT value, updated_at FROM session_data
                 WHERE account_id=$1 AND key='creds'`,
                [accountId]
            );

            if (!row) {
                issues.push({ code: 'NO_CREDS', severity: 'critical', message: 'لا توجد بيانات creds — الجلسة غير مُهيَّأة' });
                return result;
            }

            result.hasCreds    = true;
            result.lastUpdated = row.updated_at;
            result.ageHours    = Math.round((Date.now() - new Date(row.updated_at).getTime()) / 3600000);

            // فحص سلامة JSON
            let creds;
            try {
                creds = typeof row.value === 'object' ? row.value : JSON.parse(row.value);
            } catch {
                issues.push({ code: 'CREDS_JSON_CORRUPT', severity: 'critical', message: 'بيانات creds تالفة (JSON فاسد)' });
                return result;
            }

            const rawStr        = JSON.stringify(creds);
            result.credsSize    = Buffer.byteLength(rawStr, 'utf8');
            result.sizeWarning  = result.credsSize > THRESHOLDS.LARGE_CREDS_BYTES;

            if (result.sizeWarning) {
                issues.push({
                    code: 'CREDS_SIZE_LARGE',
                    severity: 'warning',
                    message: `حجم creds كبير: ${Math.round(result.credsSize / 1024)} KB`,
                });
            }

            // فحص الحقول الإلزامية
            const presentFields = Object.keys(creds);
            result.missingFields = REQUIRED_CREDS_FIELDS.filter(f => !(f in creds));
            result.extraFields   = presentFields.filter(f => !EXPECTED_CREDS_FIELDS.includes(f));

            if (result.missingFields.length > 0) {
                issues.push({
                    code:     'CREDS_MISSING_FIELDS',
                    severity: result.missingFields.includes('me') || result.missingFields.includes('account')
                              ? 'critical' : 'warning',
                    message:  `حقول مفقودة في creds: ${result.missingFields.join(', ')}`,
                });
            }

            // بيانات آمنة للعرض (بدون حقول حساسة)
            result.isRegistered = !!(creds.me?.id || creds.account);
            result.phoneNumber  = creds.me?.id
                ? creds.me.id.replace(/@.*/, '').replace(/[^0-9]/g, '')
                : null;
            result.platform    = creds.platform || null;
            result.nextPreKeyId = creds.nextPreKeyId ?? null;

            // فحص signedPreKey — هل له تاريخ صلاحية؟
            if (creds.signedPreKey?.keyPair && !creds.signedPreKey.signature) {
                issues.push({ code: 'SIGNED_PRE_KEY_NO_SIG', severity: 'warning', message: 'signedPreKey بدون توقيع' });
            }

            // كشف جلسة قديمة
            const staleDays = result.ageHours / 24;
            if (staleDays > THRESHOLDS.STALE_DAYS && !result.isRegistered) {
                issues.push({
                    code:     'CREDS_STALE',
                    severity: 'warning',
                    message:  `creds لم تتحدث منذ ${Math.round(staleDays)} يوم وغير مسجَّلة`,
                });
            }

        } catch (err) {
            issues.push({ code: 'CREDS_QUERY_ERROR', severity: 'critical', message: err.message });
        }

        return result;
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  2. فحص Signal Keys (pre-key, session, sender-key, app-state-sync-key)
    // ═══════════════════════════════════════════════════════════════════════

    async analyzeSignalKeys(accountId) {
        const issues    = [];
        const keyTypes  = ['pre-key', 'session', 'sender-key', 'app-state-sync-key'];
        const counts    = {};
        const samples   = {};
        const corruptBy = {};
        const lastUpdated = {};

        for (const type of keyTypes) {
            try {
                // عدد المفاتيح
                const countRow = await queryOne(
                    `SELECT COUNT(*) as cnt, MAX(updated_at) as last_upd
                     FROM session_data
                     WHERE account_id=$1 AND key LIKE $2`,
                    [accountId, `keys:${type}:%`]
                );
                counts[type]      = parseInt(countRow?.cnt || 0, 10);
                lastUpdated[type] = countRow?.last_upd || null;

                // فحص عيّنة عشوائية من القيم
                const sampleRows = await queryAll(
                    `SELECT key, value FROM session_data
                     WHERE account_id=$1 AND key LIKE $2
                     ORDER BY random() LIMIT $3`,
                    [accountId, `keys:${type}:%`, THRESHOLDS.SAMPLE_SIZE]
                );

                let corrupt = 0;
                const sampleKeys = [];
                for (const row of sampleRows) {
                    sampleKeys.push(row.key.replace(`keys:${type}:`, ''));
                    try {
                        const val = typeof row.value === 'object'
                            ? row.value
                            : JSON.parse(row.value);
                        if (val === null || val === undefined) corrupt++;
                    } catch {
                        corrupt++;
                    }
                }
                corruptBy[type] = corrupt;
                samples[type]   = sampleKeys.slice(0, 5);

            } catch (err) {
                counts[type]    = -1;
                corruptBy[type] = 0;
                samples[type]   = [];
                issues.push({ code: `KEY_QUERY_ERROR_${type.toUpperCase().replace(/-/g, '_')}`, severity: 'warning', message: err.message });
            }
        }

        // ── قواعد التحقق ─────────────────────────────────────────────────
        // pre-key
        if (counts['pre-key'] >= 0 && counts['pre-key'] < THRESHOLDS.MIN_PRE_KEYS) {
            issues.push({
                code:     'LOW_PRE_KEYS',
                severity: counts['pre-key'] === 0 ? 'critical' : 'warning',
                message:  `عدد pre-keys منخفض: ${counts['pre-key']} (الحد الأدنى: ${THRESHOLDS.MIN_PRE_KEYS})`,
            });
        }
        if (counts['pre-key'] > THRESHOLDS.MAX_PRE_KEYS) {
            issues.push({ code: 'PRE_KEY_BLOAT',    severity: 'warning', message: `pre-keys زائدة: ${counts['pre-key']}` });
        }
        if (counts['session'] > THRESHOLDS.MAX_SESSION_KEYS) {
            issues.push({ code: 'SESSION_KEY_BLOAT', severity: 'warning', message: `session keys زائدة: ${counts['session']}` });
        }
        if (counts['sender-key'] > THRESHOLDS.MAX_SENDER_KEYS) {
            issues.push({ code: 'SENDER_KEY_BLOAT',  severity: 'warning', message: `sender-keys زائدة: ${counts['sender-key']}` });
        }

        // مفاتيح تالفة
        for (const type of keyTypes) {
            if (corruptBy[type] > 0) {
                issues.push({
                    code:     `CORRUPT_${type.toUpperCase().replace(/-/g, '_')}_KEYS`,
                    severity: 'critical',
                    message:  `${corruptBy[type]} مفتاح تالف من نوع ${type}`,
                });
            }
        }

        return { counts, samples, corruptBy, lastUpdated, issues };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  3. تقييم قابلية استعادة الجلسة
    // ═══════════════════════════════════════════════════════════════════════

    _assessRecovery(creds, signalKeys) {
        const criticalIssues = [
            ...creds.issues,
            ...signalKeys.issues,
        ].filter(i => i.severity === 'critical');

        // لا creds → لا يمكن الاستعادة
        if (!creds.hasCreds) {
            return {
                verdict:    'needs_reconnect',
                label:      'يجب إعادة الربط',
                confidence: 100,
                reason:     'لا توجد بيانات جلسة أصلاً',
            };
        }

        // JSON تالف
        const jsonCorrupt = creds.issues.some(i => i.code === 'CREDS_JSON_CORRUPT');
        if (jsonCorrupt) {
            return {
                verdict:    'needs_reconnect',
                label:      'يجب إعادة الربط',
                confidence: 100,
                reason:     'بيانات creds تالفة لا يمكن قراءتها',
            };
        }

        // حقول إلزامية مفقودة
        if (creds.missingFields.some(f => ['me', 'account', 'noiseKey'].includes(f))) {
            return {
                verdict:    'needs_reconnect',
                label:      'يجب إعادة الربط',
                confidence: 95,
                reason:     `حقول أساسية مفقودة: ${creds.missingFields.join(', ')}`,
            };
        }

        // مفاتيح تالفة
        const hasCorruptKeys = Object.values(signalKeys.corruptBy).some(c => c > 0);
        if (hasCorruptKeys) {
            return {
                verdict:    'recoverable',
                label:      'قابلة للاستعادة — إعادة اتصال قد تكفي',
                confidence: 70,
                reason:     'بعض signal keys تالفة لكن creds سليمة',
            };
        }

        // pre-keys منعدمة
        if (signalKeys.counts['pre-key'] === 0) {
            return {
                verdict:    'recoverable',
                label:      'قابلة للاستعادة — إعادة اتصال مطلوبة',
                confidence: 65,
                reason:     'لا pre-keys متاحة — Baileys سيُعيد توليدها عند الاتصال',
            };
        }

        // مشاكل أخرى
        if (criticalIssues.length > 0) {
            return {
                verdict:    'recoverable',
                label:      'قابلة للاستعادة — مع مخاطر',
                confidence: 55,
                reason:     criticalIssues.map(i => i.message).join('; '),
            };
        }

        // جلسة سليمة
        return {
            verdict:    'healthy',
            label:      'جلسة سليمة',
            confidence: 98,
            reason:     'جميع الفحوصات اجتازت بنجاح',
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  4. إحصائيات إجمالية session_data للحساب
    // ═══════════════════════════════════════════════════════════════════════

    async getSessionStats(accountId) {
        try {
            const row = await queryOne(
                `SELECT
                    COUNT(*)                                              AS total_keys,
                    SUM(octet_length(value::text))                       AS total_bytes,
                    MAX(updated_at)                                       AS last_updated,
                    MIN(updated_at)                                       AS first_created,
                    SUM(CASE WHEN key = 'creds'                      THEN 1 ELSE 0 END) AS has_creds,
                    SUM(CASE WHEN key LIKE 'keys:pre-key:%'          THEN 1 ELSE 0 END) AS pre_key_count,
                    SUM(CASE WHEN key LIKE 'keys:session:%'          THEN 1 ELSE 0 END) AS session_key_count,
                    SUM(CASE WHEN key LIKE 'keys:sender-key:%'       THEN 1 ELSE 0 END) AS sender_key_count,
                    SUM(CASE WHEN key LIKE 'keys:app-state-sync-key:%' THEN 1 ELSE 0 END) AS app_state_key_count
                 FROM session_data
                 WHERE account_id=$1`,
                [accountId]
            );

            return {
                totalKeys:        parseInt(row?.total_keys         || 0, 10),
                totalBytes:       parseInt(row?.total_bytes        || 0, 10),
                totalKB:          Math.round((row?.total_bytes || 0) / 1024 * 10) / 10,
                lastUpdated:      row?.last_updated  || null,
                firstCreated:     row?.first_created || null,
                hasCreds:         parseInt(row?.has_creds || 0, 10) > 0,
                preKeyCount:      parseInt(row?.pre_key_count       || 0, 10),
                sessionKeyCount:  parseInt(row?.session_key_count   || 0, 10),
                senderKeyCount:   parseInt(row?.sender_key_count    || 0, 10),
                appStateKeyCount: parseInt(row?.app_state_key_count || 0, 10),
            };
        } catch (err) {
            return { error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  5. تقرير شامل لحساب واحد
    // ═══════════════════════════════════════════════════════════════════════

    async generateAccountReport(accountId) {
        const startMs = Date.now();

        const [creds, signalKeys, stats] = await Promise.all([
            this.analyzeCredentials(accountId),
            this.analyzeSignalKeys(accountId),
            this.getSessionStats(accountId),
        ]);

        const recovery = this._assessRecovery(creds, signalKeys);

        const allIssues   = [...creds.issues, ...signalKeys.issues];
        const criticals   = allIssues.filter(i => i.severity === 'critical').length;
        const warnings    = allIssues.filter(i => i.severity === 'warning').length;

        // حالة قِدَم الجلسة
        const staleDays = stats.lastUpdated
            ? (Date.now() - new Date(stats.lastUpdated).getTime()) / 86400000
            : null;
        const isStale   = staleDays !== null && staleDays > THRESHOLDS.STALE_DAYS;

        // تحديد الحالة الكلية
        let status;
        if (recovery.verdict === 'needs_reconnect') status = 'critical';
        else if (criticals > 0)                      status = 'critical';
        else if (warnings > 0 || isStale)            status = 'warning';
        else                                          status = 'healthy';

        return {
            accountId,
            status,
            recovery,
            isStale,
            staleDays:     staleDays !== null ? Math.round(staleDays) : null,
            criticalCount: criticals,
            warningCount:  warnings,
            totalIssues:   allIssues.length,
            durationMs:    Date.now() - startMs,
            analyzedAt:    new Date().toISOString(),
            credentials:   creds,
            signalKeys,
            stats,
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  6. تقرير شامل لجميع الحسابات (Admin)
    // ═══════════════════════════════════════════════════════════════════════

    async generateSystemReport() {
        const startMs = Date.now();

        // جلب كل الحسابات التي لها بيانات في session_data
        let accounts = [];
        try {
            const rows = await queryAll(
                `SELECT DISTINCT account_id FROM session_data ORDER BY account_id`
            );
            accounts = rows.map(r => r.account_id);
        } catch (err) {
            return { error: err.message, status: 'unavailable' };
        }

        // تحليل موجز لكل حساب
        const summaries = await Promise.all(
            accounts.map(id => this._quickAccountSummary(id))
        );

        const healthy      = summaries.filter(s => s.status === 'healthy').length;
        const warnings     = summaries.filter(s => s.status === 'warning').length;
        const critical     = summaries.filter(s => s.status === 'critical').length;
        const stale        = summaries.filter(s => s.isStale).length;
        const needsReconn  = summaries.filter(s => s.recovery?.verdict === 'needs_reconnect').length;

        let overallStatus;
        if (critical > 0)     overallStatus = 'critical';
        else if (warnings > 0) overallStatus = 'warning';
        else                   overallStatus = 'healthy';

        return {
            status:       overallStatus,
            totalAccounts: accounts.length,
            healthy,
            warnings,
            critical,
            stale,
            needsReconnect: needsReconn,
            durationMs:  Date.now() - startMs,
            analyzedAt:  new Date().toISOString(),
            accounts:    summaries,
        };
    }

    // ── ملخص سريع لحساب واحد (بدون تحليل عيّنة تفصيلي) ─────────────────
    async _quickAccountSummary(accountId) {
        try {
            const [creds, stats] = await Promise.all([
                this.analyzeCredentials(accountId),
                this.getSessionStats(accountId),
            ]);

            // فحص سريع للمفاتيح (عدد فقط بدون عيّنات)
            const quickKeys = {
                counts: {
                    'pre-key':             stats.preKeyCount,
                    'session':             stats.sessionKeyCount,
                    'sender-key':          stats.senderKeyCount,
                    'app-state-sync-key':  stats.appStateKeyCount,
                },
                corruptBy: { 'pre-key': 0, 'session': 0, 'sender-key': 0, 'app-state-sync-key': 0 },
                issues: [],
            };

            if (stats.preKeyCount < THRESHOLDS.MIN_PRE_KEYS) {
                quickKeys.issues.push({ code: 'LOW_PRE_KEYS', severity: stats.preKeyCount === 0 ? 'critical' : 'warning' });
            }

            const recovery = this._assessRecovery(creds, quickKeys);
            const allIssues = [...creds.issues, ...quickKeys.issues];
            const staleDays = stats.lastUpdated
                ? (Date.now() - new Date(stats.lastUpdated).getTime()) / 86400000
                : null;
            const isStale   = staleDays !== null && staleDays > THRESHOLDS.STALE_DAYS;

            let status;
            if (recovery.verdict === 'needs_reconnect') status = 'critical';
            else if (allIssues.some(i => i.severity === 'critical')) status = 'critical';
            else if (allIssues.some(i => i.severity === 'warning') || isStale) status = 'warning';
            else status = 'healthy';

            return {
                accountId,
                status,
                recovery,
                isStale,
                staleDays:    staleDays !== null ? Math.round(staleDays) : null,
                totalKeys:    stats.totalKeys,
                totalKB:      stats.totalKB,
                isRegistered: creds.isRegistered,
                phoneNumber:  creds.phoneNumber,
                platform:     creds.platform,
                lastUpdated:  stats.lastUpdated,
                issues:       allIssues.length,
            };
        } catch (err) {
            return { accountId, status: 'error', error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  7. قائمة الجلسات القديمة (Admin)
    // ═══════════════════════════════════════════════════════════════════════

    async getStaleAccounts() {
        try {
            const staleCutoff = new Date(Date.now() - THRESHOLDS.STALE_DAYS * 86400000);
            const rows = await queryAll(
                `SELECT account_id,
                        MAX(updated_at) AS last_updated,
                        COUNT(*)        AS key_count
                 FROM session_data
                 GROUP BY account_id
                 HAVING MAX(updated_at) < $1
                 ORDER BY MAX(updated_at) ASC`,
                [staleCutoff.toISOString()]
            );

            return {
                staleDaysThreshold: THRESHOLDS.STALE_DAYS,
                count: rows.length,
                accounts: rows.map(r => ({
                    accountId:   r.account_id,
                    lastUpdated: r.last_updated,
                    keyCount:    parseInt(r.key_count, 10),
                    staleDays:   Math.round(
                        (Date.now() - new Date(r.last_updated).getTime()) / 86400000
                    ),
                })),
            };
        } catch (err) {
            return { error: err.message };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    //  8. إحصائيات جلسات النظام كله (Admin)
    // ═══════════════════════════════════════════════════════════════════════

    async getSystemStats() {
        try {
            const row = await queryOne(
                `SELECT
                    COUNT(DISTINCT account_id)                           AS total_accounts,
                    COUNT(*)                                             AS total_keys,
                    SUM(octet_length(value::text))                       AS total_bytes,
                    SUM(CASE WHEN key = 'creds' THEN 1 ELSE 0 END)      AS accounts_with_creds,
                    SUM(CASE WHEN key LIKE 'keys:pre-key:%' THEN 1 ELSE 0 END)     AS total_pre_keys,
                    SUM(CASE WHEN key LIKE 'keys:session:%' THEN 1 ELSE 0 END)     AS total_session_keys,
                    SUM(CASE WHEN key LIKE 'keys:sender-key:%' THEN 1 ELSE 0 END)  AS total_sender_keys,
                    AVG(octet_length(value::text))                       AS avg_value_bytes
                 FROM session_data`
            );

            const staleRow = await queryOne(
                `SELECT COUNT(DISTINCT account_id) AS stale_count
                 FROM session_data
                 GROUP BY account_id
                 HAVING MAX(updated_at) < NOW() - INTERVAL '${THRESHOLDS.STALE_DAYS} days'`
            ).catch(() => ({ stale_count: 0 }));

            return {
                totalAccounts:      parseInt(row?.total_accounts || 0, 10),
                totalKeys:          parseInt(row?.total_keys     || 0, 10),
                totalMB:            Math.round((row?.total_bytes || 0) / 1048576 * 100) / 100,
                accountsWithCreds:  parseInt(row?.accounts_with_creds || 0, 10),
                totalPreKeys:       parseInt(row?.total_pre_keys      || 0, 10),
                totalSessionKeys:   parseInt(row?.total_session_keys  || 0, 10),
                totalSenderKeys:    parseInt(row?.total_sender_keys   || 0, 10),
                avgValueBytes:      Math.round(row?.avg_value_bytes   || 0),
                staleAccounts:      parseInt(staleRow?.stale_count    || 0, 10),
                staleDaysThreshold: THRESHOLDS.STALE_DAYS,
            };
        } catch (err) {
            return { error: err.message };
        }
    }
}

module.exports = new SessionAnalyzer();
