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
      const sock = WhatsAppManager.getSession(accountId);
      if (!sock) {
        throw new Error('الحساب غير متصل — لا يمكن الفحص');
      }

      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      // جلب قائمة المحادثات
      job.log.push({ ts: new Date().toISOString(), msg: '📋 جاري جلب قائمة المحادثات...' });
      this._emit(accountId, job);

      let chats = [];
      try {
        // Baileys: sock.chats أو sock.store?.chats
        const store = WhatsAppManager.getStore ? WhatsAppManager.getStore(accountId) : null;
        if (store && store.chats) {
          chats = Object.values(store.chats);
        } else if (sock.chats) {
          chats = Array.isArray(sock.chats) ? sock.chats : Object.values(sock.chats);
        }
      } catch (e) {
        // fallback: جلب من قاعدة البيانات
        const rows = await accountDB.all(
          `SELECT jid, name FROM group_sync_log WHERE status = 'active' LIMIT 500`
        ).catch(() => []);
        chats = rows.map(r => ({ id: r.jid, name: r.name }));
      }

      if (chats.length === 0) {
        // محاولة جلب المجموعات من جدول المجموعات إذا كان موجوداً
        const groups = await accountDB.all(
          `SELECT group_jid AS id, subject AS name FROM groups LIMIT 500`
        ).catch(() => []);
        chats = groups;
      }

      job.total = chats.length;
      job.log.push({ ts: new Date().toISOString(), msg: `📊 وُجد ${chats.length} محادثة للفحص` });
      this._emit(accountId, job);

      if (chats.length === 0) {
        job.status = 'finished';
        job.finishedAt = new Date().toISOString();
        job.log.push({ ts: new Date().toISOString(), msg: '⚠️ لا توجد محادثات متاحة للفحص' });
        this._emit(accountId, job);
        return;
      }

      // فحص كل محادثة
      for (let i = 0; i < chats.length; i++) {
        if (job._abort) break;

        const chat = chats[i];
        const jid = chat.id || chat.jid || '';
        const name = chat.name || chat.subject || chat.pushName || jid.split('@')[0];

        job.scanned = i + 1;
        job.currentChat = name || jid;
        job.progress = Math.round(((i + 1) / chats.length) * 100);
        this._emit(accountId, job);

        try {
          // جلب رسائل المحادثة (آخر 100 رسالة)
          let messages = [];
          try {
            const store = WhatsAppManager.getStore ? WhatsAppManager.getStore(accountId) : null;
            if (store && store.messages && store.messages[jid]) {
              messages = Array.from(store.messages[jid].values() || []).slice(-100);
            }
          } catch (_) {}

          // استخراج الروابط من اسم المجموعة نفسه أيضاً
          const textSources = [name, chat.description || ''];
          messages.forEach(msg => {
            const body = msg?.message?.conversation
              || msg?.message?.extendedTextMessage?.text
              || msg?.message?.imageMessage?.caption
              || msg?.message?.videoMessage?.caption
              || '';
            if (body) textSources.push(body);
          });

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
          // تجاهل أخطاء المحادثات الفردية
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

      this._emit(accountId, job);

    } catch (err) {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      job.log.push({ ts: new Date().toISOString(), msg: `❌ ${err.message}` });
      this._emit(accountId, job);
      throw err;
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

