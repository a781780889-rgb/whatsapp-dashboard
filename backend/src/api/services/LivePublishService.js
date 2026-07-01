'use strict';
/**
 * LivePublishService — خدمة النشر المباشر
 * تُدير جلسات النشر غير المتزامنة مع دعم:
 * - تعدد الحسابات والمجموعات والإعلانات
 * - الإيقاف المؤقت / الاستئناف / الإيقاف الكامل
 * - إعادة المحاولة التلقائية عند الفشل
 * - إرسال تحديثات Socket.IO لحظية
 */
const crypto     = require('crypto');
const path       = require('path');
const fs         = require('fs');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const DatabaseManager = require('../../database/DatabaseManager');
const SystemDB        = require('../../database/SystemDB');
const SocketBridge    = require('../../core/SocketBridge');
const { queryAll: pgQueryAll } = require('../../lib/postgres');

const MAX_RETRY   = 2;
const ROOM_PRE    = 'live_publish:';
const GC_DELAY_MS = 30 * 60_000;   // تنظيف الجلسة من الذاكرة بعد 30 دقيقة

// ════════════════════════════════════════════════════════════
//  LiveSession  — حالة جلسة نشر واحدة
// ════════════════════════════════════════════════════════════
class LiveSession {
    constructor(id, cfg, resumeCursor = null) {
        this.id     = id;
        this.cfg    = cfg;
        this.status = 'running';   // running | paused | stopped | complete | error
        this._pauseQ = [];         // قائمة resolve functions لـ pause

        // [استمرارية النشر] مؤشر يحدد من أين نستأنف بعد إعادة تشغيل الخادم:
        // فهرس الحساب الحالي وفهرس المجموعة الحالية داخل accountIds/groupJids.
        // يُحدَّث بعد اكتمال كل مجموعة، ويُحفَظ في قاعدة البيانات دورياً.
        this.cursor = resumeCursor || { accountIndex: 0, groupIndex: 0 };

        this.stats = {
            totalGroups:        0,
            completedGroups:    0,
            totalMessages:      0,
            sentMessages:       0,
            failedMessages:     0,
            totalMembers:       0,
            sentMembers:        0,
            failedMembers:      0,
            eligibleMembers:    0,   // [فلتر السعودية] أعضاء مؤهلون للإرسال (غير مشرف + رقم سعودي)
            excludedAdmins:     0,   // [فلتر السعودية] مشرفون/مالكون تم استثناؤهم
            excludedNonSaudi:   0,   // [فلتر السعودية] أرقام غير سعودية تم استبعادها
            errorCount:         0,
            percentComplete:    0,
            speed:              0,      // رسائل / دقيقة
            startTime:          Date.now(),
            elapsedMs:          0,
            etaMs:              null,
            currentAccountId:   null,
            currentAccountName: null,
            currentGroupJid:    null,
            currentGroupName:   null,
            currentAdName:      null,
        };

        this.logs          = [];    // آخر 500 سجل
        this._speedBuffer  = [];    // طوابع زمنية للرسائل المرسلة (30 ثانية متحركة)
    }

    // ── تحكم ────────────────────────────────────────────────────
    pause() {
        if (this.status === 'running') {
            this.status = 'paused';
            this._emitProgress();
        }
    }

    resume() {
        if (this.status === 'paused') {
            this.status = 'running';
            const q = this._pauseQ.splice(0);
            q.forEach(r => r());
            this._emitProgress();
        }
    }

    stop() {
        if (this.status !== 'complete' && this.status !== 'error') {
            this.status = 'stopped';
            const q = this._pauseQ.splice(0);
            q.forEach(r => r());
            this._emitProgress();
        }
    }

    async waitIfPaused() {
        while (this.status === 'paused') {
            await new Promise(r => this._pauseQ.push(r));
        }
        return this.status !== 'stopped';
    }

    // ── تسجيل ───────────────────────────────────────────────────
    log(level, msg, details = null) {
        const entry = {
            id:        crypto.randomBytes(4).toString('hex'),
            timestamp: Date.now(),
            level,     // info | success | error | warning
            message:   msg,
            details,
        };
        this.logs.push(entry);
        if (this.logs.length > 500) this.logs = this.logs.slice(-400);

        // [عرض تفاصيل اللوحة أونلاين] هذه الأحداث كانت تُبث فقط عبر Socket.IO
        // للواجهة، فلا تظهر إطلاقاً في سجلات الخادم (Railway Deploy Logs) —
        // فمهما فشلت جلسة نشر، لا يوجد أي أثر يمكن تتبعه من لوحة Railway.
        // نُكرّر كل حدث هنا أيضاً في console حتى يمكن متابعة/تشخيص النشر
        // المباشر فعلياً من سجلات الخادم أونلاين، تماماً كباقي الخدمات.
        const tag  = `[LivePublish:${this.id.slice(0, 8)}]`;
        const line = details ? `${tag} ${msg} — ${details}` : `${tag} ${msg}`;
        if (level === 'error')        console.error(line);
        else if (level === 'warning') console.warn(line);
        else                           console.log(line);

        SocketBridge.to(`${ROOM_PRE}${this.id}`).emit('live_publish:log', {
            sessionId: this.id, ...entry,
        });
    }

    // ── إحصائيات ─────────────────────────────────────────────────
    tick(patch = {}) {
        Object.assign(this.stats, patch);
        const now = Date.now();
        this.stats.elapsedMs = now - this.stats.startTime;

        // سرعة متحركة (رسائل / دقيقة عبر آخر 30 ثانية)
        this._speedBuffer = this._speedBuffer.filter(t => now - t < 30_000);
        this.stats.speed  = Math.round((this._speedBuffer.length / 30) * 60);

        // تقدير الوقت المتبقي
        const done      = this.stats.sentMessages + this.stats.failedMessages;
        const remaining = Math.max(0, this.stats.totalMessages - done);
        const spd       = this.stats.speed > 0 ? this.stats.speed : 0.5;
        this.stats.etaMs = remaining > 0 ? Math.round((remaining / spd) * 60_000) : 0;

        // نسبة الإتمام
        const total = this.stats.totalGroups || 1;
        this.stats.percentComplete = Math.min(
            100, Math.round((this.stats.completedGroups / total) * 100)
        );

        this._emitProgress();
    }

    recordSent() { this._speedBuffer.push(Date.now()); }

    _emitProgress() {
        SocketBridge.to(`${ROOM_PRE}${this.id}`).emit('live_publish:progress', {
            sessionId: this.id,
            status:    this.status,
            ...this.stats,
        });
    }
}

// ════════════════════════════════════════════════════════════
//  LivePublishService
// ════════════════════════════════════════════════════════════
class LivePublishService {
    constructor() {
        this._sessions = new Map();
        this._userIdCache = new Map(); // [البند 1+2] كاش بسيط: accountId → { userId, ts }
    }

    // ── [البند 1+2] جلب userId لحساب معين، بكاش قصير لتفادي ضغط DB داخل
    //    حلقات الإرسال الكثيفة في جلسات Live Publish الطويلة ─────────────────
    async _getUserId(accountId) {
        const cached = this._userIdCache.get(accountId);
        if (cached && (Date.now() - cached.ts) < 60000) return cached.userId;
        try {
            const rows = await pgQueryAll(`SELECT user_id, created_at FROM accounts WHERE id = $1`, [accountId]);
            const userId    = rows?.[0]?.user_id || null;
            const createdAt = rows?.[0]?.created_at || null;
            this._userIdCache.set(accountId, { userId, createdAt, ts: Date.now() });
            return userId;
        } catch {
            return null;
        }
    }

    async _getAccountCreatedAt(accountId) {
        const cached = this._userIdCache.get(accountId);
        if (cached) return cached.createdAt || null;
        await this._getUserId(accountId);
        return this._userIdCache.get(accountId)?.createdAt || null;
    }

    // ── [إصلاح الفارق الزمني الحقيقي] تأخير يحترم القيمة التي حدّدها المستخدم
    //    فعلياً من واجهة النشر المباشر (groupDelayMs/memberDelayMs/adDelayMs)،
    //    مع استخدام حد الحماية الأدنى فقط كـ "أرضية أمان" لا تُخترق أبداً
    //    (لتفادي تجاوز حدود الحماية المفروضة على الحساب)، بدل تجاهل اختيار
    //    المستخدم بالكامل واستبداله بتأخير عشوائي كما كان يحدث سابقاً.
    //    @param {string} accountId
    //    @param {'group'|'private'|'ad'} kind  نوع التأخير المطلوب من cfg.delays
    async _safeDelay(sess, accountId, kind = 'group') {
        // القيمة التي اختارها المستخدم فعلياً من واجهة النشر المباشر (خاصة بهذه الجلسة)
        const userMs = this._userDelayMs(sess, kind);
        return this._sleep(userMs);
    }

    // ── قراءة قيمة التأخير التي اختارها المستخدم من cfg.delays الخاصة بالجلسة (ms) ─
    _userDelayMs(sess, kind) {
        const delays = sess?.cfg?.delays || {};
        if (kind === 'private') return Math.max(0, Number(delays.memberDelayMs) || 1500);
        if (kind === 'ad')      return Math.max(0, Number(delays.adDelayMs)     || 2000);
        return Math.max(0, Number(delays.groupDelayMs) || 1000);
    }

    // ── [استمرارية النشر] حفظ/تحميل/حذف الجلسة من قاعدة البيانات ─────────────
    async _persistSession(sess) {
        try {
            await SystemDB.run(
                `INSERT INTO live_publish_sessions (id, status, cfg, cursor, stats, updated_at)
                 VALUES ($1, $2, $3, $4, $5, NOW())
                 ON CONFLICT (id) DO UPDATE SET
                    status = EXCLUDED.status,
                    cursor = EXCLUDED.cursor,
                    stats  = EXCLUDED.stats,
                    updated_at = NOW()`,
                [sess.id, sess.status, JSON.stringify(sess.cfg), JSON.stringify(sess.cursor), JSON.stringify(sess.stats)]
            );
        } catch (e) {
            console.error('[LivePublishService] فشل حفظ الجلسة:', e.message);
        }
    }

    async _deleteSessionRecord(id) {
        try { await SystemDB.run(`DELETE FROM live_publish_sessions WHERE id = $1`, [id]); } catch {}
    }

    // [استمرارية النشر] تُستدعى مرة واحدة عند بدء تشغيل الخادم لاستئناف أي
    // جلسات كانت "running" أو "paused" وقت توقف العملية (Railway restart/crash).
    async resumeAll() {
        let rows = [];
        try {
            rows = await SystemDB.all(
                `SELECT id, status, cfg, cursor, stats FROM live_publish_sessions WHERE status IN ('running', 'paused')`
            );
        } catch (e) {
            console.error('[LivePublishService] فشل تحميل الجلسات للاستئناف:', e.message);
            return;
        }

        for (const row of rows) {
            try {
                const cfg    = typeof row.cfg === 'string' ? JSON.parse(row.cfg) : row.cfg;
                const cursor = typeof row.cursor === 'string' ? JSON.parse(row.cursor) : row.cursor;
                const prevStats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats;

                const session = new LiveSession(row.id, cfg, cursor || { accountIndex: 0, groupIndex: 0 });
                if (prevStats) Object.assign(session.stats, prevStats, { startTime: prevStats.startTime || Date.now() });
                session.status = row.status === 'paused' ? 'paused' : 'running';
                this._sessions.set(session.id, session);

                session.log('warning', '🔄 تم استئناف جلسة النشر تلقائياً بعد إعادة تشغيل الخادم');

                setImmediate(() => {
                    this._run(session).catch(err => {
                        session.status = 'error';
                        session.log('error', `خطأ فادح: ${err.message}`);
                        session._emitProgress();
                        this._persistSession(session);
                    });
                });
            } catch (e) {
                console.error(`[LivePublishService] فشل استئناف الجلسة ${row.id}:`, e.message);
            }
        }

        if (rows.length) {
            console.log(`[LivePublishService] تم استئناف ${rows.length} جلسة نشر مباشر بعد إعادة التشغيل.`);
        }
    }

    // ── API عام ──────────────────────────────────────────────────
    async create(cfg) {
        const id      = crypto.randomUUID();
        const session = new LiveSession(id, cfg);
        this._sessions.set(id, session);
        await this._persistSession(session);

        // تشغيل بشكل غير متزامن
        setImmediate(() => {
            this._run(session).catch(err => {
                session.status = 'error';
                session.log('error', `خطأ فادح: ${err.message}`);
                session._emitProgress();
                this._persistSession(session);
            });
        });

        return id;
    }

    pause(id) {
        const s = this._sessions.get(id);
        if (s) { s.pause(); this._persistSession(s); }
        return !!s;
    }
    resume(id) {
        const s = this._sessions.get(id);
        if (s) { s.resume(); this._persistSession(s); }
        return !!s;
    }
    stop(id) {
        const s = this._sessions.get(id);
        if (s) { s.stop(); this._persistSession(s); }
        return !!s;
    }

    status(id) {
        const s = this._sessions.get(id);
        if (!s) return null;
        return { sessionId: s.id, status: s.status, ...s.stats, logs: s.logs.slice(-200) };
    }

    // ── [إصلاح استمرارية اللوحة] إيجاد جلسة نشطة (running/paused) مرتبطة بأي
    //    من الحسابات المُمرَّرة — يُستخدم عند فتح صفحة النشر المباشر من جديد
    //    (بعد الخروج منها أو إعادة تحميل المتصفح) لإعادة ربط الواجهة تلقائياً
    //    بالجلسة الجارية فعلياً في الخادم بدل ظهور لوحة فارغة/متجمّدة عند 0%.
    //    يبحث أولاً في الذاكرة (الأسرع)، ثم في قاعدة البيانات كخط دفاع أخير
    //    (حالة إعادة تشغيل الخادم بين لحظة مغادرة الصفحة والعودة إليها).
    async findActiveSession(accountIds = []) {
        const idSet = new Set(accountIds);

        // 1) البحث في الجلسات الحيّة بالذاكرة أولاً
        for (const s of this._sessions.values()) {
            if (s.status !== 'running' && s.status !== 'paused') continue;
            const cfgAccountIds = s.cfg?.accountIds || [];
            if (cfgAccountIds.some(id => idSet.has(id))) {
                return { sessionId: s.id, status: s.status, ...s.stats, logs: s.logs.slice(-200) };
            }
        }

        // 2) خط دفاع: قاعدة البيانات (تغطي حالة إعادة تشغيل الخادم قبل استكمال resumeAll)
        try {
            const rows = await SystemDB.all(
                `SELECT id, status, cfg, stats FROM live_publish_sessions WHERE status IN ('running', 'paused')`
            );
            for (const row of rows) {
                const cfg = typeof row.cfg === 'string' ? JSON.parse(row.cfg) : row.cfg;
                const cfgAccountIds = cfg?.accountIds || [];
                if (cfgAccountIds.some((id) => idSet.has(id))) {
                    const stats = typeof row.stats === 'string' ? JSON.parse(row.stats) : row.stats;
                    return { sessionId: row.id, status: row.status, ...(stats || {}), logs: [] };
                }
            }
        } catch (e) {
            console.error('[LivePublishService] findActiveSession DB fallback error:', e.message);
        }

        return null;
    }

    // ── الحلقة الرئيسية ───────────────────────────────────────────
    async _run(sess) {
        const { accountIds, accountsInfo, groupJids, sendToMembers, excludeAdmins, messages } = sess.cfg;
        // [إصلاح الفارق الزمني الحقيقي] delays{} (memberDelayMs/groupDelayMs/adDelayMs)
        // هي القيم التي حدّدها المستخدم فعلياً من واجهة النشر المباشر، ويجب
        // احترامها كأساس التوقيت الحقيقي بين كل عملية وأخرى.

        // تهيئة الإجماليات
        const totalGroups = accountIds.length * groupJids.length;
        sess.stats.totalGroups   = totalGroups;
        sess.stats.totalMessages = totalGroups * messages.length;
        sess.tick();

        sess.log('info',
            `🚀 بدء جلسة نشر — ${accountIds.length} حساب × ${groupJids.length} مجموعة × ${messages.length} إعلان`
        );

        // [استمرارية النشر] إن كانت هذه جلسة مُستأنَفة، نبدأ من فهرس الحساب/المجموعة
        // المحفوظ بدل إعادة كل شيء من الصفر.
        const startAccountIndex = sess.cursor.accountIndex || 0;
        let persistTimer = setInterval(() => this._persistSession(sess), 15_000);

        // ── حلقة الحسابات ───────────────────────────────────────
        for (let accIdx = startAccountIndex; accIdx < accountIds.length; accIdx++) {
            const accountId = accountIds[accIdx];
            sess.cursor.accountIndex = accIdx;
            if (!(await sess.waitIfPaused())) break;

            const accInfo = (accountsInfo || []).find(a => a.id === accountId);
            const accName = accInfo?.name || accountId.slice(0, 8);

            sess.tick({ currentAccountId: accountId, currentAccountName: accName, currentGroupJid: null, currentGroupName: null });
            sess.log('info', `🔑 الحساب النشط: ${accName}`);

            const waSession = WhatsAppManager.getSession(accountId);
            if (!waSession) {
                sess.log('error', `الحساب "${accName}" غير متصل — تم التخطي`);
                sess.stats.errorCount++;
                sess.stats.completedGroups += groupJids.length;
                sess.tick();
                continue;
            }

            // [FIX-LIVE-PUBLISH-READY] الـ socket موجود لكن قد لا يكون قد أكمل
            // المصافحة الفعلية مع واتساب بعد (خاصة مباشرة بعد إعادة تشغيل
            // الخادم على Railway، أو عند بدء جلسة نشر فور الضغط على "بدء" بينما
            // الحساب لا يزال يتصل). سابقاً كان الكود يعتبر أي socket موجود
            // = "متصل" فيدخل حلقة الإرسال مباشرة، فتفشل أول محاولة إرسال فوراً
            // وتُسجَّل المجموعة "مكتملة" مع خطأ واحد ودون أي رسائل مُرسلة أو
            // فاشلة فعلياً — بالضبط الأعراض التي كانت تظهر في اللوحة (1/1
            // مجموعات، 0 رسائل مُرسلة، 0 فاشلة، 1 خطأ). الآن ننتظر جاهزية
            // حقيقية حتى 20 ثانية قبل المتابعة، بدل الفشل الفوري.
            if (!WhatsAppManager.isReady(accountId)) {
                sess.log('warning', `⏳ الحساب "${accName}" لا يزال يتصل بواتساب — انتظار اكتمال الاتصال...`);
                const becameReady = await WhatsAppManager.waitUntilReady(accountId, 20_000);
                if (!becameReady) {
                    sess.log('error', `الحساب "${accName}" لم يكتمل اتصاله خلال المهلة — تم التخطي`);
                    sess.stats.errorCount++;
                    sess.stats.completedGroups += groupJids.length;
                    sess.tick();
                    continue;
                }
                sess.log('success', `✅ الحساب "${accName}" أصبح جاهزاً — استئناف النشر`);
            }

            let accountSuspendedMidRun = false; // يبقى false دائماً بعد إزالة نظام الحماية — محفوظ للتوافق مع منطق التحكم بالحلقة

            let accountDB;
            try { accountDB = await DatabaseManager.getAccountDB(accountId); } catch { accountDB = null; }

            // ── حلقة المجموعات ────────────────────────────────────
            // [استمرارية النشر] عند استئناف الحساب الذي توقفنا عنده، نبدأ من فهرس
            // المجموعة المحفوظ؛ أما الحسابات التالية فتبدأ من الصفر كالمعتاد.
            const startGroupIndex = (accIdx === startAccountIndex) ? (sess.cursor.groupIndex || 0) : 0;
            for (let grpIdx = startGroupIndex; grpIdx < groupJids.length; grpIdx++) {
                const jid = groupJids[grpIdx];
                sess.cursor.groupIndex = grpIdx;
                if (accountSuspendedMidRun) {
                    sess.stats.completedGroups++;
                    sess.tick();
                    continue;
                }
                if (!(await sess.waitIfPaused())) break;

                const groupName = await this._groupName(accountDB, jid);
                sess.tick({ currentGroupJid: jid, currentGroupName: groupName });
                sess.log('info', `📍 المجموعة: ${groupName}`);

                // ── إرسال الإعلانات للمجموعة ──────────────────────
                for (let i = 0; i < messages.length && !accountSuspendedMidRun; i++) {
                    if (!(await sess.waitIfPaused())) break;
                    const msg = messages[i];
                    sess.tick({ currentAdName: msg.name || 'رسالة مخصصة' });

                    let sent = false;
                    for (let attempt = 1; attempt <= MAX_RETRY + 1 && !sent && !accountSuspendedMidRun; attempt++) {
                        try {
                            await this._send(accountId, jid, msg, { operationType: 'group' });
                            sess.stats.sentMessages++;
                            sess.recordSent();
                            sess.log('success', `✅ "${msg.name || 'رسالة'}" → ${groupName}`);
                            sent = true;
                        } catch (e) {
                            // [البند 3] حظر/تعليق = توقف فوري بدون إعادة محاولة على الإطلاق
                            if (e.protectionReason === 'account_suspended') {
                                accountSuspendedMidRun = true;
                                sess.stats.failedMessages++;
                                sess.stats.errorCount++;
                                sess.log('error', `🚫 الحساب تعلّق أثناء الإرسال — إيقاف فوري لكل عمليات هذا الحساب`, e.message);
                                break;
                            }
                            // [البند 8] لا نعيد المحاولة لأخطاء غير قابلة لإعادة المحاولة (مثل invalid jid)
                            // [FIX-LIVE-PUBLISH-READY] 'not_ready' (الاتصال لم يكتمل بعد) خطأ عابر
                            // بطبيعته ويجب إعادة المحاولة، وليس فشلاً نهائياً كأخطاء
                            // invalid jid/forbidden.
                            const RETRYABLE_REASONS = new Set(['rate_limit_hour', 'rate_limit_day', 'not_ready']);
                            const nonRetryable = e.protectionReason && !RETRYABLE_REASONS.has(e.protectionReason);
                            if (attempt <= MAX_RETRY && !nonRetryable) {
                                sess.log('warning', `⚠️ إعادة المحاولة ${attempt}/${MAX_RETRY} — ${groupName}`, e.message);
                                await this._safeDelay(sess, accountId, 'group');
                            } else {
                                sess.stats.failedMessages++;
                                sess.stats.errorCount++;
                                sess.log('error', `❌ فشل "${msg.name || 'رسالة'}" → ${groupName}`, e.message);
                            }
                        }
                    }
                    sess.tick();
                    if (i < messages.length - 1 && !accountSuspendedMidRun) {
                        // [إصلاح الفارق الزمني الحقيقي] فاصل بين الإعلانات = adDelayMs الذي حدّده المستخدم
                        await this._safeDelay(sess, accountId, 'ad');
                    }
                }

                // ── إرسال خاص للأعضاء ─────────────────────────────
                if (sendToMembers && !accountSuspendedMidRun) {
                    if (!(await sess.waitIfPaused())) break;
                    try {
                        const membersInfo = await WhatsAppManager.getGroupMembers(accountId, jid);

                        // [فلتر السعودية + استثناء المشرفين — إلزامي دائمًا]
                        // 1) استبعاد كل المشرفين/السوبر أدمن/مالك المجموعة (target_jids لا تحتوي عليهم أصلاً،
                        //    لكن نُبقي الفحص صريحًا هنا لضمان الالتزام حتى لو تغيّر مصدر البيانات مستقبلاً).
                        const nonAdminMembers = (membersInfo.target_jids || [])
                            .filter(memberJid => !(membersInfo.admins || []).includes(memberJid));

                        const excludedAdminsCount = (membersInfo.admins || []).length;

                        // 2) الإبقاء فقط على الأرقام السعودية (+966) — الفحص يتم على رقم الهاتف
                        //    الحقيقي (phone_by_jid) وليس على الـ jid مباشرة، لأن الأخير قد يكون
                        //    معرّف LID داخلي عشوائي عند تفعيل خصوصية الرقم في واتساب.
                        const phoneByJid    = membersInfo.phone_by_jid    || {};
                        const sendableByJid = membersInfo.sendable_by_jid || {};
                        const targets = nonAdminMembers.filter(memberJid => {
                            const realPhone = phoneByJid[memberJid] || memberJid;
                            return this._isSaudiNumber(realPhone);
                        });
                        const nonSaudiExcluded = nonAdminMembers.length - targets.length;

                        sess.stats.totalMembers      += targets.length;
                        sess.stats.eligibleMembers   += targets.length;
                        sess.stats.excludedAdmins    += excludedAdminsCount;
                        sess.stats.excludedNonSaudi  += nonSaudiExcluded;

                        sess.log('info',
                            `👥 ${groupName} — مؤهلون: ${targets.length} | ` +
                            `مشرفون مستثناة: ${excludedAdminsCount} | ` +
                            `أرقام غير سعودية مستبعدة: ${nonSaudiExcluded}`
                        );

                        for (const memberJid of targets) {
                            if (accountSuspendedMidRun) break;
                            if (!(await sess.waitIfPaused())) break;

                            // [إصلاح الإرسال الخاص] لا نُرسل مباشرة إلى الـ jid الخام القادم من
                            // بيانات المجموعة (قد يكون @lid — معرّف داخلي لا يستقبل رسائل خاصة
                            // حقيقية على تطبيق واتساب). نستخدم الـ jid الفعلي القابل للإرسال
                            // (sendable_by_jid)، وإن تعذّر توفره نتخطى العضو مع تسجيل السبب
                            // بدل تسجيله كإرسال ناجح وهمي.
                            const sendJid = sendableByJid[memberJid];
                            if (!sendJid) {
                                sess.stats.failedMembers++;
                                sess.stats.errorCount++;
                                sess.log('error', `❌ خاص → ${memberJid.split('@')[0]}`, 'تعذّر تحديد رقم/معرّف قابل لاستقبال رسالة خاصة (LID بدون رقم حقيقي)');
                                sess.tick();
                                continue;
                            }

                            for (let i = 0; i < messages.length && !accountSuspendedMidRun; i++) {
                                const msg = messages[i];
                                // [إصلاح الإرسال الخاص] إعادة محاولة حقيقية (MAX_RETRY) لأخطاء
                                // قابلة للإعادة — كانت غائبة هنا سابقاً، فأي فشل عابر (مهلة اتصال،
                                // ازدحام مؤقت) كان يُسجَّل فشلاً نهائياً من أول محاولة بلا فرصة ثانية،
                                // خلافاً لحلقة إرسال المجموعات التي تملك هذه الآلية بالفعل.
                                let sentMember = false;
                                for (let attempt = 1; attempt <= MAX_RETRY + 1 && !sentMember && !accountSuspendedMidRun; attempt++) {
                                    try {
                                        await this._send(accountId, sendJid, msg, { operationType: 'private' });
                                        sess.stats.sentMembers++;
                                        sess.recordSent();
                                        sess.log('success', `✅ خاص → ${sendJid.split('@')[0]}`);
                                        sentMember = true;
                                    } catch (e) {
                                        // [البند 3] توقف فوري لكل عمليات هذا الحساب عند تعليقه
                                        if (e.protectionReason === 'account_suspended') {
                                            accountSuspendedMidRun = true;
                                            sess.stats.failedMembers++;
                                            sess.stats.errorCount++;
                                            sess.log('error', `🚫 الحساب تعلّق أثناء الإرسال الخاص — إيقاف فوري`);
                                            break;
                                        }
                                        // أخطاء غير قابلة لإعادة المحاولة (رقم غير موجود، jid خاطئ...) لا داعي لتكرارها
                                        // [FIX-LIVE-PUBLISH-READY] 'not_ready' (الاتصال لم يكتمل بعد) خطأ عابر
                            // بطبيعته ويجب إعادة المحاولة، وليس فشلاً نهائياً كأخطاء
                            // invalid jid/forbidden.
                            const RETRYABLE_REASONS = new Set(['rate_limit_hour', 'rate_limit_day', 'not_ready']);
                            const nonRetryable = e.protectionReason && !RETRYABLE_REASONS.has(e.protectionReason);
                                        if (attempt <= MAX_RETRY && !nonRetryable) {
                                            sess.log('warning', `⚠️ إعادة المحاولة ${attempt}/${MAX_RETRY} — خاص → ${sendJid.split('@')[0]}`, e.message);
                                            await this._safeDelay(sess, accountId, 'private');
                                        } else {
                                            sess.stats.failedMembers++;
                                            sess.stats.errorCount++;
                                            sess.log('error', `❌ خاص → ${sendJid.split('@')[0]}`, e.message);
                                        }
                                    }
                                }
                                sess.tick();
                                if (i < messages.length - 1 && !accountSuspendedMidRun) {
                                    // فاصل بين الإعلانات المتعددة المرسلة لنفس العضو خاص
                                    await this._safeDelay(sess, accountId, 'ad');
                                }
                            }
                            if (!accountSuspendedMidRun) {
                                // [إصلاح الفارق الزمني الحقيقي] فاصل ثابت = memberDelayMs الذي
                                // حدّده المستخدم فعلياً (مثال: كل 5 دقائق رسالة خاصة واحدة فقط)،
                                // يُطبَّق بعد كل عضو — سواء داخل نفس المجموعة أو عند الانتقال
                                // لمجموعة تالية، فالمعدّل ثابت وحقيقي عبر كامل الجلسة.
                                await this._safeDelay(sess, accountId, 'private');
                            }
                        }
                    } catch (e) {
                        sess.log('error', `فشل جلب أعضاء ${groupName}`, e.message);
                        sess.stats.errorCount++;
                    }
                }

                sess.stats.completedGroups++;
                sess.tick();
                sess.log('info', `✓ اكتملت: ${groupName}`);
                // [استمرارية النشر] تقديم المؤشر للمجموعة التالية فور الاكتمال
                sess.cursor.groupIndex = grpIdx + 1;
                if (!accountSuspendedMidRun) {
                    // [إصلاح الفارق الزمني الحقيقي] فاصل بين كل مجموعة = groupDelayMs الذي حدّده المستخدم
                    await this._safeDelay(sess, accountId, 'group');
                }
            }
            // [استمرارية النشر] انتقلنا لحساب جديد بالكامل — إعادة تصفير مؤشر المجموعة
            sess.cursor.accountIndex = accIdx + 1;
            sess.cursor.groupIndex   = 0;
        }

        clearInterval(persistTimer);

        // ── إنهاء الجلسة ──────────────────────────────────────────
        if (sess.status !== 'stopped') sess.status = 'complete';

        sess.tick({
            percentComplete: sess.status === 'complete' ? 100 : sess.stats.percentComplete,
            currentGroupJid: null, currentGroupName: null,
            currentAdName: null,   currentAccountId: null,
        });

        sess.log(
            sess.status === 'complete' ? 'success' : 'warning',
            `📊 ${sess.status === 'complete' ? 'اكتملت' : 'أُوقفت'} عملية النشر — ` +
            `✅ ${sess.stats.sentMessages} مجموعة + ${sess.stats.sentMembers} خاص | ` +
            `❌ ${sess.stats.failedMessages + sess.stats.failedMembers} فشل | ` +
            `👥 مؤهلون: ${sess.stats.eligibleMembers} | ` +
            `🚫 مشرفون مستثناة: ${sess.stats.excludedAdmins} | ` +
            `🌍 غير سعودية مستبعدة: ${sess.stats.excludedNonSaudi} | ` +
            `⚠️ ${sess.stats.errorCount} خطأ`
        );

        SocketBridge.to(`${ROOM_PRE}${sess.id}`).emit('live_publish:complete', {
            sessionId: sess.id, status: sess.status, stats: sess.stats,
        });

        // [استمرارية النشر] عند الاكتمال أو الإيقاف الكامل لا حاجة للاحتفاظ بالسجل
        // في قاعدة البيانات؛ أما "stopped" (إيقاف مؤقت لم يُستأنف) فتُحدَّث حالته فقط
        // لتفادي استئناف جلسة أوقفها المستخدم عمداً.
        if (sess.status === 'complete') {
            await this._deleteSessionRecord(sess.id);
        } else {
            await this._persistSession(sess);
        }

        // تنظيف ذاكري بعد 30 دقيقة
        setTimeout(() => this._sessions.delete(sess.id), GC_DELAY_MS);
    }

    // ── [فلتر السعودية] هل رقم العضو سعودي (+966)؟ ─────────────────
    //    jid على شكل "9665xxxxxxxx@s.whatsapp.net" أو "+9665xxxxxxxx@..."
    _isSaudiNumber(jidOrPhone) {
        if (!jidOrPhone) return false;
        const raw = String(jidOrPhone).split('@')[0].replace(/[^\d+]/g, '');
        const normalized = raw.startsWith('+') ? raw : `+${raw}`;
        return normalized.startsWith('+966');
    }

    // ── مساعدات ──────────────────────────────────────────────────
    async _groupName(db, jid) {
        if (!db) return jid.split('@')[0];
        try {
            const row = await db.get(`SELECT name FROM wa_groups WHERE group_jid = $1`, [jid]);
            return row?.name || jid.split('@')[0];
        } catch {
            return jid.split('@')[0];
        }
    }

    // ── [البند 1] إرسال محمي عبر النقطة المركزية الوحيدة في WhatsAppManager:
    //    فحص حدود + محاكاة بشرية + تسجيل نجاح/فشل تلقائي. لا إرسال مباشر. ────
    async _send(accountId, jid, msg, options = {}) {
        const MEDIA_BASE = path.resolve(__dirname, '../../../../');
        let content;
        if (msg.mediaPaths?.length) {
            const mp = path.join(MEDIA_BASE, msg.mediaPaths[0]);
            if (fs.existsSync(mp)) {
                const buf = fs.readFileSync(mp);
                const ext = path.extname(mp).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                    content = { image: buf, caption: msg.text || '' };
                } else if (['.mp4', '.mov', '.avi'].includes(ext)) {
                    content = { video: buf, caption: msg.text || '' };
                } else {
                    content = { document: buf, caption: msg.text || '', fileName: path.basename(mp) };
                }
            }
        }
        if (!content) content = { text: msg.text || ' ' };

        return WhatsAppManager.sendMessageSafe(accountId, jid, content, options);
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
}

module.exports = new LivePublishService();
