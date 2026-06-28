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
const SocketBridge    = require('../../core/SocketBridge');

const MAX_RETRY   = 2;
const ROOM_PRE    = 'live_publish:';
const GC_DELAY_MS = 30 * 60_000;   // تنظيف الجلسة من الذاكرة بعد 30 دقيقة

// ════════════════════════════════════════════════════════════
//  LiveSession  — حالة جلسة نشر واحدة
// ════════════════════════════════════════════════════════════
class LiveSession {
    constructor(id, cfg) {
        this.id     = id;
        this.cfg    = cfg;
        this.status = 'running';   // running | paused | stopped | complete | error
        this._pauseQ = [];         // قائمة resolve functions لـ pause

        this.stats = {
            totalGroups:        0,
            completedGroups:    0,
            totalMessages:      0,
            sentMessages:       0,
            failedMessages:     0,
            totalMembers:       0,
            sentMembers:        0,
            failedMembers:      0,
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
    }

    // ── API عام ──────────────────────────────────────────────────
    async create(cfg) {
        const id      = crypto.randomUUID();
        const session = new LiveSession(id, cfg);
        this._sessions.set(id, session);

        // تشغيل بشكل غير متزامن
        setImmediate(() => {
            this._run(session).catch(err => {
                session.status = 'error';
                session.log('error', `خطأ فادح: ${err.message}`);
                session._emitProgress();
            });
        });

        return id;
    }

    pause(id)  { const s = this._sessions.get(id); if (s) s.pause();  return !!s; }
    resume(id) { const s = this._sessions.get(id); if (s) s.resume(); return !!s; }
    stop(id)   { const s = this._sessions.get(id); if (s) s.stop();   return !!s; }

    status(id) {
        const s = this._sessions.get(id);
        if (!s) return null;
        return { sessionId: s.id, status: s.status, ...s.stats, logs: s.logs.slice(-200) };
    }

    // ── الحلقة الرئيسية ───────────────────────────────────────────
    async _run(sess) {
        const {
            accountIds, accountsInfo, groupJids,
            sendToMembers, excludeAdmins, messages, delays,
        } = sess.cfg;
        const { memberDelayMs, groupDelayMs, adDelayMs } = delays;

        // تهيئة الإجماليات
        const totalGroups = accountIds.length * groupJids.length;
        sess.stats.totalGroups   = totalGroups;
        sess.stats.totalMessages = totalGroups * messages.length;
        sess.tick();

        sess.log('info',
            `🚀 بدء جلسة نشر — ${accountIds.length} حساب × ${groupJids.length} مجموعة × ${messages.length} إعلان`
        );

        // ── حلقة الحسابات ───────────────────────────────────────
        for (const accountId of accountIds) {
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

            let accountDB;
            try { accountDB = await DatabaseManager.getAccountDB(accountId); } catch { accountDB = null; }

            // ── حلقة المجموعات ────────────────────────────────────
            for (const jid of groupJids) {
                if (!(await sess.waitIfPaused())) break;

                const groupName = await this._groupName(accountDB, jid);
                sess.tick({ currentGroupJid: jid, currentGroupName: groupName });
                sess.log('info', `📍 المجموعة: ${groupName}`);

                // ── إرسال الإعلانات للمجموعة ──────────────────────
                for (let i = 0; i < messages.length; i++) {
                    if (!(await sess.waitIfPaused())) break;
                    const msg = messages[i];
                    sess.tick({ currentAdName: msg.name || 'رسالة مخصصة' });

                    let sent = false;
                    for (let attempt = 1; attempt <= MAX_RETRY + 1 && !sent; attempt++) {
                        try {
                            await this._send(waSession, jid, msg);
                            sess.stats.sentMessages++;
                            sess.recordSent();
                            sess.log('success', `✅ "${msg.name || 'رسالة'}" → ${groupName}`);
                            sent = true;
                        } catch (e) {
                            if (attempt <= MAX_RETRY) {
                                sess.log('warning', `⚠️ إعادة المحاولة ${attempt}/${MAX_RETRY} — ${groupName}`, e.message);
                                await this._sleep(600 * attempt);
                            } else {
                                sess.stats.failedMessages++;
                                sess.stats.errorCount++;
                                sess.log('error', `❌ فشل "${msg.name || 'رسالة'}" → ${groupName}`, e.message);
                            }
                        }
                    }
                    sess.tick();
                    if (i < messages.length - 1) await this._sleep(adDelayMs);
                }

                // ── إرسال خاص للأعضاء ─────────────────────────────
                if (sendToMembers) {
                    if (!(await sess.waitIfPaused())) break;
                    try {
                        const membersInfo = await WhatsAppManager.getGroupMembers(accountId, jid);
                        const targets     = excludeAdmins
                            ? (membersInfo.target_jids || [])
                            : [...(membersInfo.target_jids || []), ...(membersInfo.admins || [])];

                        sess.stats.totalMembers += targets.length;
                        sess.log('info', `👥 رسائل خاصة لـ ${targets.length} عضو في ${groupName}`);

                        for (const memberJid of targets) {
                            if (!(await sess.waitIfPaused())) break;
                            for (let i = 0; i < messages.length; i++) {
                                const msg = messages[i];
                                try {
                                    await this._send(waSession, memberJid, msg);
                                    sess.stats.sentMembers++;
                                    sess.recordSent();
                                    sess.log('success', `✅ خاص → ${memberJid.split('@')[0]}`);
                                } catch (e) {
                                    sess.stats.failedMembers++;
                                    sess.stats.errorCount++;
                                    sess.log('error', `❌ خاص → ${memberJid.split('@')[0]}`, e.message);
                                }
                                sess.tick();
                                if (i < messages.length - 1) await this._sleep(adDelayMs);
                            }
                            await this._sleep(memberDelayMs);
                        }
                    } catch (e) {
                        sess.log('error', `فشل جلب أعضاء ${groupName}`, e.message);
                        sess.stats.errorCount++;
                    }
                }

                sess.stats.completedGroups++;
                sess.tick();
                sess.log('info', `✓ اكتملت: ${groupName}`);
                await this._sleep(groupDelayMs);
            }
        }

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
            `⚠️ ${sess.stats.errorCount} خطأ`
        );

        SocketBridge.to(`${ROOM_PRE}${sess.id}`).emit('live_publish:complete', {
            sessionId: sess.id, status: sess.status, stats: sess.stats,
        });

        // تنظيف ذاكري بعد 30 دقيقة
        setTimeout(() => this._sessions.delete(sess.id), GC_DELAY_MS);
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

    async _send(waSession, jid, msg) {
        const MEDIA_BASE = path.resolve(__dirname, '../../../../');
        if (msg.mediaPaths?.length) {
            const mp  = path.join(MEDIA_BASE, msg.mediaPaths[0]);
            if (fs.existsSync(mp)) {
                const buf = fs.readFileSync(mp);
                const ext = path.extname(mp).toLowerCase();
                if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) {
                    return waSession.sendMessage(jid, { image: buf, caption: msg.text || '' });
                }
                if (['.mp4', '.mov', '.avi'].includes(ext)) {
                    return waSession.sendMessage(jid, { video: buf, caption: msg.text || '' });
                }
                return waSession.sendMessage(jid, {
                    document: buf, caption: msg.text || '',
                    fileName: path.basename(mp),
                });
            }
        }
        return waSession.sendMessage(jid, { text: msg.text || ' ' });
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
}

module.exports = new LivePublishService();
