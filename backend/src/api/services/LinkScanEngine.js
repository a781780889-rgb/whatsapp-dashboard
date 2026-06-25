'use strict';
/**
 * LinkScanEngine — محرك البحث التلقائي عن روابط الدعوة
 *
 * المهام:
 * - فحص جميع محادثات ومجموعات الحساب المحدد
 * - استخراج روابط الدعوة (واتساب / تيليجرام / قنوات)
 * - حفظها في قاعدة البيانات مع إزالة المكرر
 * - إرسال تحديثات لحظية عبر Socket.IO
 * - دعم الإيقاف والاستكمال
 */

const WhatsAppManager = require('../../bot/WhatsAppManager');
const DatabaseManager = require('../../database/DatabaseManager');
const LinkExtractorService = require('./LinkExtractorService');

// نمط روابط الدعوة
const INVITE_PATTERNS = [
  /https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/gi,
  /https?:\/\/wa\.me\/([A-Za-z0-9_-]{10,})/gi,
  /https?:\/\/t\.me\/([A-Za-z0-9_+]{3,})/gi,
  /https?:\/\/telegram\.me\/([A-Za-z0-9_+]{3,})/gi,
  /https?:\/\/t\.me\/joinchat\/([A-Za-z0-9_-]{10,})/gi,
  /https?:\/\/t\.me\/\+([A-Za-z0-9_-]{10,})/gi,
];

function extractLinksFromText(text) {
  if (!text || typeof text !== 'string') return [];
  const found = new Set();
  for (const pattern of INVITE_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text)) !== null) {
      found.add(m[0].trim());
    }
  }
  return [...found];
}

function detectLinkType(url) {
  if (/chat\.whatsapp\.com/.test(url)) return 'whatsapp_group';
  if (/wa\.me/.test(url)) return 'whatsapp_group';
  if (/t\.me\/joinchat|t\.me\/\+/.test(url)) return 'telegram_group';
  if (/t\.me\//.test(url)) return 'telegram';
  if (/telegram\.me/.test(url)) return 'telegram';
  return 'other';
}

class LinkScanEngine {
  constructor() {
    // حالة كل مهمة فحص: accountId → ScanJob
    this._jobs = new Map();
    // Socket.IO instance (يُضبط من الخارج)
    this._io = null;
  }

  setSocketIO(io) {
    this._io = io;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  الحصول على حالة مهمة
  // ══════════════════════════════════════════════════════════════════════════
  getJob(accountId) {
    return this._jobs.get(accountId) || {
      status: 'idle',
      progress: 0,
      total: 0,
      scanned: 0,
      found: 0,
      duplicates: 0,
      currentChat: null,
      startedAt: null,
      finishedAt: null,
      log: [],
    };
  }

  getAllJobs() {
    const result = {};
    for (const [id, job] of this._jobs.entries()) {
      result[id] = job;
    }
    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  بدء مهمة الفحص
  // ══════════════════════════════════════════════════════════════════════════
  async startScan(accountIds) {
    if (!Array.isArray(accountIds)) accountIds = [accountIds];
    const started = [];

    for (const accountId of accountIds) {
      const existing = this._jobs.get(accountId);
      if (existing && existing.status === 'running') {
        continue; // لا تبدأ مهمة ثانية
      }

      const job = {
        status: 'running',
        progress: 0,
        total: 0,
        scanned: 0,
        found: 0,
        duplicates: 0,
        currentChat: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        log: [],
        _abort: false,
      };
      this._jobs.set(accountId, job);
      started.push(accountId);

      // تشغيل في الخلفية بدون await
      this._runScan(accountId, job).catch(err => {
        job.status = 'error';
        job.log.push({ ts: new Date().toISOString(), msg: `❌ خطأ: ${err.message}` });
        this._emit(accountId, job);
      });
    }

    return started;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  إيقاف مهمة الفحص
  // ══════════════════════════════════════════════════════════════════════════
  stopScan(accountId) {
    const job = this._jobs.get(accountId);
    if (!job || job.status !== 'running') return false;
    job._abort = true;
    job.status = 'stopped';
    job.log.push({ ts: new Date().toISOString(), msg: '⏹ تم إيقاف الفحص' });
    this._emit(accountId, job);
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  تنفيذ الفحص الفعلي
  // ══════════════════════════════════════════════════════════════════════════
  async _runScan(accountId, job) {
    try {
      // ── [FIX-ROOT] فحص حالة الجلسة بدقة قبل أي شيء ──────────────────────
      // كانت المشكلة السابقة تُظهر "0 محادثة" حتى لو كانت الجلسة منتهية أو
      // الـ QR لم يُمسح بعد، لأن الكود القديم لم يكن يُفرّق بين "متصل بدون
      // محادثات" و "غير متصل أصلاً". الآن نُفرّق بوضوح ونمنع تشغيل فحص
      // لحساب غير متصل حقيقةً.
      const isOnline = WhatsAppManager.isOnline(accountId);
      const sock = WhatsAppManager.getSession(accountId);
      const qrPending = WhatsAppManager.getQrStatus(accountId);

      console.log(`[LinkScanEngine] ── بدء الفحص ──────────────────────────────`);
      console.log(`[LinkScanEngine] Account: ${accountId}`);
      console.log(`[LinkScanEngine] Session Connected: ${isOnline}`);
      console.log(`[LinkScanEngine] Socket Present: ${!!sock}`);
      console.log(`[LinkScanEngine] QR Pending: ${!!qrPending}`);

      if (!isOnline || !sock) {
        const reason = qrPending
          ? 'الحساب غير متصل — يوجد QR لم يتم مسحه بعد. يرجى مسح QR لإكمال الربط'
          : 'الحساب غير متصل بواتساب — يرجى إعادة ربط الجلسة';
        job.status = 'error';
        job.finishedAt = new Date().toISOString();
        job.log.push({ ts: new Date().toISOString(), msg: `❌ ${reason}` });
        console.log(`[LinkScanEngine] ⛔ توقف: ${reason}`);
        this._emit(accountId, job);
        return;
      }

      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      // ── جلب المحادثات الحقيقية من واتساب مباشرة ─────────────────────────
      job.log.push({ ts: new Date().toISOString(), msg: '⏳ جاري تحميل المحادثات...' });
      this._emit(accountId, job);

      const { chats, groupsCount, privateCount, excluded, excludedReasons, source }
        = await this._fetchRealChats(accountId, sock, accountDB);

      job.total = chats.length;

      console.log(`[LinkScanEngine] Source: ${source}`);
      console.log(`[LinkScanEngine] Fetched Chats: ${chats.length}`);
      console.log(`[LinkScanEngine] Groups: ${groupsCount}`);
      console.log(`[LinkScanEngine] Private Chats: ${privateCount}`);
      console.log(`[LinkScanEngine] Excluded: ${excluded}`);
      if (excluded > 0) {
        console.log(`[LinkScanEngine] Excluded Reasons: ${JSON.stringify(excludedReasons)}`);
      }
      console.log(`[LinkScanEngine] Ready For Scan: ${chats.length}`);

      job.log.push({
        ts: new Date().toISOString(),
        msg: `✅ تم العثور على ${chats.length} محادثة — ${groupsCount} مجموعة، ${privateCount} محادثة خاصة`,
      });
      this._emit(accountId, job);

      if (chats.length === 0) {
        job.status = 'finished';
        job.finishedAt = new Date().toISOString();
        job.log.push({
          ts: new Date().toISOString(),
          msg: '⚠️ الحساب متصل لكن لا توجد مجموعات أو محادثات منضم إليها حالياً',
        });
        this._emit(accountId, job);
        return;
      }

      // فحص كل محادثة
      for (let i = 0; i < chats.length; i++) {
        if (job._abort) break;

        const chat = chats[i];
        const jid = chat.id;
        const name = chat.name || jid.split('@')[0];

        job.scanned = i + 1;
        job.currentChat = name || jid;
        job.progress = Math.round(((i + 1) / chats.length) * 100);
        this._emit(accountId, job);

        try {
          // استخراج الروابط من: اسم المحادثة + الوصف (إن وُجد للمجموعات)
          const textSources = [name, chat.description || ''];

          const allText = textSources.join(' ');
          const links = extractLinksFromText(allText);

          for (const url of links) {
            if (job._abort) break;
            const linkType = detectLinkType(url);
            const saved = await this._saveLink(accountDB, accountId, url, linkType, jid);
            if (saved === 'new') {
              job.found++;
              job.log.push({
                ts: new Date().toISOString(),
                msg: `🔗 رابط جديد: ${url.replace('https://', '').slice(0, 50)}`,
                url, linkType, from: name,
              });
              this._emit(accountId, job);
            } else if (saved === 'duplicate') {
              job.duplicates++;
            }
          }
        } catch (chatErr) {
          console.error(`[LinkScanEngine] خطأ في فحص المحادثة ${jid}:`, chatErr.message);
        }

        // انتظار قصير لتجنب إرهاق الموارد
        if (i % 20 === 0 && i > 0) {
          await new Promise(r => setTimeout(r, 100));
        }
      }

      if (!job._abort) {
        job.status = 'finished';
        job.progress = 100;
        job.finishedAt = new Date().toISOString();
        job.log.push({
          ts: new Date().toISOString(),
          msg: `✅ اكتمل الفحص — وُجد ${job.found} رابط جديد، ${job.duplicates} مكرر`,
        });
      }

      console.log(`[LinkScanEngine] ── انتهى الفحص: ${job.found} رابط جديد، ${job.duplicates} مكرر ──`);
      this._emit(accountId, job);

    } catch (err) {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      job.log.push({ ts: new Date().toISOString(), msg: `❌ ${err.message}` });
      console.error(`[LinkScanEngine] خطأ فادح في الفحص لحساب ${accountId}:`, err.message);
      this._emit(accountId, job);
      throw err;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  [FIX-ROOT] جلب المحادثات الحقيقية من واتساب مباشرة
  //
  //  السبب الجذري للمشكلة القديمة: الكود كان يعتمد على `sock.chats` أو
  //  `WhatsAppManager.getStore(accountId)` كمصدر بيانات، لكن Baileys لا
  //  يُخزّن قائمة محادثات في الذاكرة من تلقاء نفسه (هذا يتطلب
  //  makeInMemoryStore منفصلاً لم يكن مُفعّلاً في WhatsAppManager) —
  //  فكانت النتيجة دائماً مصفوفة فارغة بصرف النظر عن حالة الحساب.
  //  الـ fallback القديم كان يقرأ أيضاً من جدول `groups` غير الموجود
  //  (الجدول الحقيقي اسمه `wa_groups`)، فيفشل بصمت ويُعيد 0 دائماً.
  //
  //  الحل: الاستدعاء المباشر لـ sock.groupFetchAllParticipating() — وهي
  //  نفس الدالة الموثوقة المستخدمة فعلياً في GroupController._syncFromWhatsApp
  //  لمزامنة المجموعات — مع fallback صحيح من جدول wa_groups الحقيقي
  //  عند فشل الاتصال المباشر بواتساب لأي سبب عارض.
  // ══════════════════════════════════════════════════════════════════════════
  async _fetchRealChats(accountId, sock, accountDB) {
    const excludedReasons = {};
    let excluded = 0;
    let source = 'whatsapp_live';

    try {
      // المصدر الأساسي: جلب مباشر وحي من واتساب (مجموعات أنت عضو فيها فعلاً)
      const raw = await sock.groupFetchAllParticipating();
      const entries = Object.entries(raw || {});

      console.log(`[LinkScanEngine] groupFetchAllParticipating returned ${entries.length} entries`);

      const chats = [];
      for (const [jid, meta] of entries) {
        if (!jid || !jid.endsWith('@g.us')) {
          excluded++;
          excludedReasons['not_a_group'] = (excludedReasons['not_a_group'] || 0) + 1;
          continue;
        }
        chats.push({
          id: jid,
          name: meta.subject || jid.split('@')[0],
          description: meta.desc || '',
          isGroup: true,
        });
      }

      // محاولة إضافة محادثات خاصة من السجل التاريخي (تقريبية وليست حية)
      // ── ملاحظة صدق تقنية: Baileys لا يكشف قائمة محادثات خاصة بدون
      // makeInMemoryStore دائم (غير مُفعَّل في هذا النظام). الجدول التالي
      // قد لا يكون موجوداً إن لم يُسجَّل أي تدفق رسائل بعد — هذا متوقع
      // وليس خطأ، ويُعامَل كمصدر تكميلي تقريبي لا كمصدر أساسي موثوق.
      let privateRows = [];
      try {
        const tableExists = await accountDB.get(
          `SELECT EXISTS (
             SELECT 1 FROM information_schema.tables
             WHERE table_name = 'baileys_message_flow'
           ) AS exists`
        );
        if (tableExists?.exists) {
          privateRows = await accountDB.all(
            `SELECT DISTINCT jid AS id, jid AS name
             FROM baileys_message_flow
             WHERE account_id = $1 AND jid IS NOT NULL AND jid LIKE '%@s.whatsapp.net'
             LIMIT 1000`,
            [accountId]
          ).catch(() => []);
        } else {
          console.log('[LinkScanEngine] جدول baileys_message_flow غير موجود — لا توجد محادثات خاصة تقريبية متاحة');
        }
      } catch (privErr) {
        console.warn(`[LinkScanEngine] تعذّر فحص جدول المحادثات الخاصة: ${privErr.message}`);
      }

      const privateCount = privateRows.length;
      for (const row of privateRows) {
        chats.push({ id: row.id, name: row.name, description: '', isGroup: false });
      }

      return {
        chats,
        groupsCount: chats.length - privateCount,
        privateCount,
        excluded,
        excludedReasons,
        source,
      };

    } catch (liveErr) {
      // المصدر الاحتياطي: قراءة من جدول wa_groups الحقيقي (آخر مزامنة محفوظة)
      console.warn(`[LinkScanEngine] فشل الجلب المباشر من واتساب: ${liveErr.message} — التحويل لـ wa_groups`);
      source = 'wa_groups_fallback';

      const rows = await accountDB.all(
        `SELECT group_jid AS id, name, description FROM wa_groups WHERE is_member = TRUE LIMIT 2000`
      ).catch((dbErr) => {
        console.error(`[LinkScanEngine] فشل أيضاً قراءة wa_groups: ${dbErr.message}`);
        return [];
      });

      return {
        chats: rows,
        groupsCount: rows.length,
        privateCount: 0,
        excluded,
        excludedReasons,
        source,
      };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  حفظ رابط في قاعدة البيانات
  // ══════════════════════════════════════════════════════════════════════════
  async _saveLink(accountDB, accountId, url, linkType, groupJid) {
    try {
      // فحص التكرار
      const existing = await accountDB.get(
        `SELECT id FROM discovered_links WHERE url = $1`,
        [url]
      );
      if (existing) return 'duplicate';

      // حفظ الرابط الجديد
      await accountDB.run(
        `INSERT INTO discovered_links
         (url, link_type, group_jid, discovered_by_account, status, join_attempts, discovered_at, updated_at)
         VALUES ($1, $2, $3, $4, 'new', 0, NOW(), NOW())
         ON CONFLICT (url) DO NOTHING`,
        [url, linkType, groupJid || null, accountId]
      );
      return 'new';
    } catch (err) {
      return 'error';
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  إنشاء جدول discovered_links
  // ══════════════════════════════════════════════════════════════════════════
  async _ensureTables(accountDB) {
    await accountDB.run(`
      CREATE TABLE IF NOT EXISTS discovered_links (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        url                   TEXT NOT NULL UNIQUE,
        group_name            TEXT,
        link_type             TEXT DEFAULT 'other',
        group_jid             TEXT,
        discovered_by_account TEXT,
        status                TEXT DEFAULT 'new',
        join_account_used     TEXT,
        joined_at             TIMESTAMPTZ,
        join_fail_reason      TEXT,
        join_attempts         INTEGER DEFAULT 0,
        discovered_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at            TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // إضافة الأعمدة الناقصة إن وُجدت
    const cols = [
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS group_name TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_account_used TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_fail_reason TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_attempts INTEGER DEFAULT 0`,
    ];
    for (const sql of cols) {
      await accountDB.run(sql).catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  إرسال حدث Socket.IO
  // ══════════════════════════════════════════════════════════════════════════
  _emit(accountId, job) {
    if (!this._io) return;
    try {
      this._io.emit(`link_scan_${accountId}`, {
        accountId,
        status: job.status,
        progress: job.progress,
        total: job.total,
        scanned: job.scanned,
        found: job.found,
        duplicates: job.duplicates,
        currentChat: job.currentChat,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
        lastLog: job.log[job.log.length - 1] || null,
      });
      // حدث عام أيضاً
      this._io.emit('link_scan_update', { accountId, status: job.status, found: job.found });
    } catch (_) {}
  }
}

module.exports = new LinkScanEngine();

