'use strict';
/**
 * LinkJoinController — نظام الانضمام بالروابط (متعدد الحسابات)
 *
 * Endpoints:
 *   GET  /links/join/dashboard          — إحصائيات عامة لجميع الحسابات
 *   GET  /links/join/all-links          — كل الروابط عبر الحسابات (مع فلترة)
 *   GET  /links/join/joined-links       — الروابط التي تم الانضمام إليها
 *   GET  /links/join/unjoined-links     — الروابط غير المنضم إليها
 *   GET  /links/join/history            — سجل الانضمام الكلي
 *   POST /links/join/execute            — تنفيذ الانضمام (متعدد الحسابات)
 *   POST /links/join/add-links          — إضافة روابط يدوياً
 *   GET  /links/join/auto-mode          — حالة الوضع التلقائي
 *   POST /links/join/auto-mode/start    — تشغيل الوضع التلقائي
 *   POST /links/join/auto-mode/stop     — إيقاف الوضع التلقائي
 *   GET  /links/join/auto-settings      — إعدادات الوضع التلقائي
 *   PUT  /links/join/auto-settings      — تحديث الإعدادات
 */

const DatabaseManager  = require('../../database/DatabaseManager');
const WhatsAppManager  = require('../../bot/WhatsAppManager');
const crypto           = require('crypto');

// نمط روابط واتساب
const WA_INVITE_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/;

// إعدادات الوضع التلقائي (في الذاكرة)
const autoModeState = {
  isRunning:    false,
  startedAt:    null,
  intervalId:   null,
  settings: {
    accountIds:        [],
    delaySeconds:      30,
    randomDelay:       false,
    randomDelayMax:    60,
    linkTypes:         ['whatsapp_group'],
    maxPerRun:         20,
    intervalMinutes:   5,
    distributionMode:  'all',
  },
  stats: {
    totalJoined:  0,
    totalFailed:  0,
    lastRunAt:    null,
    runCount:     0,
  },
};

// إحصائيات العمليات الجارية
const activeJobs = new Map(); // jobId → { status, progress, total, done }

class LinkJoinController {

  // ══════════════════════════════════════════════════════════════════════════
  //  ضمان وجود الجداول في قاعدة البيانات
  // ══════════════════════════════════════════════════════════════════════════
  async _ensureTables(accountDB) {
    const stmts = [
      `CREATE TABLE IF NOT EXISTS discovered_links (
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
      )`,
      `CREATE TABLE IF NOT EXISTS join_history (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        link_id       UUID,
        url           TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        status        TEXT DEFAULT 'pending',
        result_msg    TEXT,
        fail_reason   TEXT,
        attempted_at  TIMESTAMPTZ DEFAULT NOW()
      )`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS group_name TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_account_used TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_fail_reason TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_attempts INTEGER DEFAULT 0`,
    ];
    for (const sql of stmts) {
      await accountDB.run(sql).catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  الحصول على جميع الحسابات المتاحة
  // ══════════════════════════════════════════════════════════════════════════
  async _getAllAccounts(userId, isAdmin) {
    try {
      let accounts;
      if (isAdmin) {
        accounts = await DatabaseManager.systemDB.all(`SELECT id, name, phone_number, status FROM accounts ORDER BY created_at ASC`);
      } else {
        accounts = await DatabaseManager.systemDB.all(
          `SELECT id, name, phone_number, status FROM accounts WHERE user_id = $1 ORDER BY created_at ASC`,
          [userId]
        );
      }
      return accounts || [];
    } catch {
      return [];
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  1. لوحة التحكم الرئيسية — إحصائيات عامة
  // ══════════════════════════════════════════════════════════════════════════
  async getDashboard(req, res) {
    try {
      const isAdmin = ['super_admin', 'admin'].includes(req.user?.role);
      const accounts = await this._getAllAccounts(req.user?.id, isAdmin);

      let totalNew = 0, totalJoined = 0, totalFailed = 0;
      let totalBlocked = 0, totalDisabled = 0, totalPending = 0;
      let joinedToday = 0, failedToday = 0, totalLinks = 0;
      const byType = {};
      const byAccount = [];

      for (const acc of accounts) {
        try {
          const db = await DatabaseManager.getAccountDB(acc.id);
          await this._ensureTables(db);

          const [stats, today, typed] = await Promise.all([
            db.all(`SELECT status, COUNT(*) AS cnt FROM discovered_links GROUP BY status`),
            db.all(`SELECT status, COUNT(*) AS cnt FROM discovered_links WHERE updated_at >= NOW() - INTERVAL '1 day' GROUP BY status`),
            db.all(`SELECT link_type, COUNT(*) AS cnt FROM discovered_links GROUP BY link_type`),
          ]);

          const accStats = { new: 0, joined: 0, failed: 0, blocked: 0, disabled: 0 };
          let accTotal = 0;
          for (const r of stats) {
            accStats[r.status] = Number(r.cnt);
            accTotal += Number(r.cnt);
          }
          totalNew      += accStats.new;
          totalJoined   += accStats.joined;
          totalFailed   += accStats.failed;
          totalBlocked  += accStats.blocked;
          totalDisabled += accStats.disabled;
          totalLinks    += accTotal;

          for (const r of today) {
            if (r.status === 'joined')   joinedToday += Number(r.cnt);
            if (r.status === 'failed')   failedToday += Number(r.cnt);
          }
          for (const r of typed) {
            byType[r.link_type] = (byType[r.link_type] || 0) + Number(r.cnt);
          }

          byAccount.push({
            accountId: acc.id,
            name: acc.name || acc.phone_number || acc.id,
            phone: acc.phone_number,
            status: acc.status,
            total: accTotal,
            ...accStats,
          });
        } catch { /* skip broken account */ }
      }

      res.json({
        success: true,
        dashboard: {
          totalLinks,
          totalNew,
          totalJoined,
          totalFailed,
          totalBlocked,
          totalDisabled,
          totalPending,
          joinedToday,
          failedToday,
          accountsCount: accounts.length,
          byType: Object.entries(byType).map(([link_type, cnt]) => ({ link_type, cnt })),
          byAccount,
          autoMode: {
            isRunning: autoModeState.isRunning,
            startedAt: autoModeState.startedAt,
            ...autoModeState.stats,
          },
        },
      });
    } catch (err) {
      console.error('[LinkJoin] getDashboard error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  2. جميع الروابط عبر الحسابات (مع فلترة متقدمة)
  // ══════════════════════════════════════════════════════════════════════════
  async getAllLinks(req, res) {
    try {
      const isAdmin = ['super_admin', 'admin'].includes(req.user?.role);
      const accounts = await this._getAllAccounts(req.user?.id, isAdmin);

      const {
        accountIds: accFilter = '',
        status:     statusFilter = '',
        linkType:   typeFilter = '',
        search:     searchFilter = '',
        page  = 1,
        limit = 50,
      } = req.query;

      const filterAccIds = accFilter ? accFilter.split(',') : null;
      const targetAccounts = filterAccIds
        ? accounts.filter(a => filterAccIds.includes(a.id))
        : accounts;

      const allLinks = [];

      for (const acc of targetAccounts) {
        try {
          const db = await DatabaseManager.getAccountDB(acc.id);
          await this._ensureTables(db);

          const conditions = [];
          const params = [];

          if (statusFilter) {
            const statuses = statusFilter.split(',').filter(Boolean);
            if (statuses.length > 0) {
              const placeholders = statuses.map((_, i) => `$${params.length + i + 1}`).join(',');
              conditions.push(`status IN (${placeholders})`);
              params.push(...statuses);
            }
          }
          if (typeFilter) {
            params.push(typeFilter);
            conditions.push(`link_type = $${params.length}`);
          }
          if (searchFilter) {
            params.push(`%${searchFilter}%`);
            conditions.push(`(url ILIKE $${params.length} OR group_name ILIKE $${params.length})`);
          }

          const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
          const links = await db.all(
            `SELECT id, url, group_name, link_type, status, join_account_used,
                    joined_at, join_fail_reason, join_attempts, discovered_at, updated_at
             FROM discovered_links ${where} ORDER BY discovered_at DESC LIMIT 500`,
            params
          );

          for (const l of links) {
            allLinks.push({ ...l, accountId: acc.id, accountName: acc.name || acc.phone_number || acc.id });
          }
        } catch { /* skip */ }
      }

      // Sort by most recent
      allLinks.sort((a, b) => new Date(b.discovered_at) - new Date(a.discovered_at));

      const pageN  = Math.max(1, Number(page));
      const limitN = Math.min(200, Math.max(10, Number(limit)));
      const total  = allLinks.length;
      const links  = allLinks.slice((pageN - 1) * limitN, pageN * limitN);

      res.json({
        success: true,
        links,
        total,
        page: pageN,
        pages: Math.ceil(total / limitN),
      });
    } catch (err) {
      console.error('[LinkJoin] getAllLinks error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  3. الروابط التي تم الانضمام إليها (لوحة منفصلة)
  // ══════════════════════════════════════════════════════════════════════════
  async getJoinedLinks(req, res) {
    try {
      const isAdmin = ['super_admin', 'admin'].includes(req.user?.role);
      const accounts = await this._getAllAccounts(req.user?.id, isAdmin);

      const { accountIds: accFilter = '', page = 1, limit = 50 } = req.query;
      const filterAccIds = accFilter ? accFilter.split(',') : null;
      const targetAccounts = filterAccIds
        ? accounts.filter(a => filterAccIds.includes(a.id))
        : accounts;

      const joinedLinks = [];

      for (const acc of targetAccounts) {
        try {
          const db = await DatabaseManager.getAccountDB(acc.id);
          await this._ensureTables(db);

          const links = await db.all(`
            SELECT id, url, group_name, link_type, join_account_used,
                   joined_at, join_attempts, discovered_at
            FROM discovered_links
            WHERE status = 'joined'
            ORDER BY joined_at DESC NULLS LAST
            LIMIT 500
          `);

          for (const l of links) {
            joinedLinks.push({
              ...l,
              accountId:   acc.id,
              accountName: acc.name || acc.phone_number || acc.id,
            });
          }
        } catch { /* skip */ }
      }

      joinedLinks.sort((a, b) => new Date(b.joined_at || 0) - new Date(a.joined_at || 0));

      const pageN  = Math.max(1, Number(page));
      const limitN = Math.min(200, Math.max(10, Number(limit)));
      const total  = joinedLinks.length;
      const links  = joinedLinks.slice((pageN - 1) * limitN, pageN * limitN);

      res.json({ success: true, links, total, page: pageN, pages: Math.ceil(total / limitN) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  4. الروابط غير المنضم إليها (لوحة منفصلة)
  // ══════════════════════════════════════════════════════════════════════════
  async getUnjoinedLinks(req, res) {
    try {
      const isAdmin = ['super_admin', 'admin'].includes(req.user?.role);
      const accounts = await this._getAllAccounts(req.user?.id, isAdmin);

      const { accountIds: accFilter = '', page = 1, limit = 50 } = req.query;
      const filterAccIds = accFilter ? accFilter.split(',') : null;
      const targetAccounts = filterAccIds
        ? accounts.filter(a => filterAccIds.includes(a.id))
        : accounts;

      const unjoinedLinks = [];

      for (const acc of targetAccounts) {
        try {
          const db = await DatabaseManager.getAccountDB(acc.id);
          await this._ensureTables(db);

          const links = await db.all(`
            SELECT id, url, group_name, link_type, status,
                   join_fail_reason, join_attempts, discovered_at, updated_at
            FROM discovered_links
            WHERE status IN ('new','failed','disabled','blocked')
            ORDER BY discovered_at DESC
            LIMIT 500
          `);

          for (const l of links) {
            unjoinedLinks.push({
              ...l,
              accountId:   acc.id,
              accountName: acc.name || acc.phone_number || acc.id,
            });
          }
        } catch { /* skip */ }
      }

      unjoinedLinks.sort((a, b) => new Date(b.discovered_at) - new Date(a.discovered_at));

      const pageN  = Math.max(1, Number(page));
      const limitN = Math.min(200, Math.max(10, Number(limit)));
      const total  = unjoinedLinks.length;
      const links  = unjoinedLinks.slice((pageN - 1) * limitN, pageN * limitN);

      res.json({ success: true, links, total, page: pageN, pages: Math.ceil(total / limitN) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  5. سجل الانضمام الكلي عبر الحسابات
  // ══════════════════════════════════════════════════════════════════════════
  async getJoinHistory(req, res) {
    try {
      const isAdmin = ['super_admin', 'admin'].includes(req.user?.role);
      const accounts = await this._getAllAccounts(req.user?.id, isAdmin);
      const { page = 1, limit = 50 } = req.query;
      const allHistory = [];

      for (const acc of accounts) {
        try {
          const db = await DatabaseManager.getAccountDB(acc.id);
          await this._ensureTables(db);

          const rows = await db.all(`
            SELECT jh.id, jh.url, jh.account_id, jh.status,
                   jh.result_msg, jh.fail_reason, jh.attempted_at,
                   dl.group_name, dl.link_type
            FROM join_history jh
            LEFT JOIN discovered_links dl ON jh.link_id = dl.id
            ORDER BY jh.attempted_at DESC
            LIMIT 200
          `);

          for (const r of rows) {
            allHistory.push({
              ...r,
              sourceAccountId:   acc.id,
              sourceAccountName: acc.name || acc.phone_number || acc.id,
            });
          }
        } catch { /* skip */ }
      }

      allHistory.sort((a, b) => new Date(b.attempted_at) - new Date(a.attempted_at));

      const pageN  = Math.max(1, Number(page));
      const limitN = Math.min(200, Math.max(10, Number(limit)));
      const total  = allHistory.length;
      const history = allHistory.slice((pageN - 1) * limitN, pageN * limitN);

      res.json({ success: true, history, total, page: pageN, pages: Math.ceil(total / limitN) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  6. تنفيذ الانضمام (متعدد الحسابات)
  // ══════════════════════════════════════════════════════════════════════════
  async executeJoin(req, res) {
    try {
      const {
        links:           linksData   = [],
        accountIds:      accountIds  = [],
        sourceAccountId,
        delaySeconds     = 30,
        randomDelay      = false,
        randomDelayMax   = 60,
        distributionMode = 'single',
        linkType         = 'direct',
      } = req.body;

      if (!sourceAccountId) {
        return res.status(400).json({ success: false, error: 'sourceAccountId مطلوب' });
      }
      if (!linksData || linksData.length === 0) {
        return res.status(400).json({ success: false, error: 'لم يتم تحديد أي روابط للانضمام' });
      }

      const effectiveAccIds = accountIds.length > 0 ? accountIds : [sourceAccountId];
      const jobId = crypto.randomUUID();

      // تسجيل الوظيفة
      activeJobs.set(jobId, { status: 'running', total: linksData.length, done: 0, startedAt: new Date() });

      // تشغيل في الخلفية
      this._runMultiJoin(sourceAccountId, linksData, effectiveAccIds, {
        delaySeconds, randomDelay, randomDelayMax, distributionMode, linkType, jobId,
      }).catch(err => console.error('[LinkJoin] executeJoin error:', err));

      res.json({
        success:  true,
        jobId,
        message:  `جاري الانضمام لـ ${linksData.length} رابط على ${effectiveAccIds.length} حساب`,
        linksCount:   linksData.length,
        accountsCount: effectiveAccIds.length,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── تنفيذ الانضمام في الخلفية ───────────────────────────────────────────
  async _runMultiJoin(sourceAccountId, linksData, accountIds, options) {
    const { delaySeconds, randomDelay, randomDelayMax, jobId } = options;

    let done = 0;
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < linksData.length; i++) {
      const linkItem = linksData[i];
      const url = linkItem.url || linkItem;
      const linkId = linkItem.id || null;
      const targetAccountId = accountIds[i % accountIds.length];

      try {
        const db = await DatabaseManager.getAccountDB(sourceAccountId);
        await this._ensureTables(db);

        const sock = WhatsAppManager.getSession(targetAccountId);
        if (!sock) {
          await this._recordJoin(db, linkId, url, targetAccountId, 'failed', 'الحساب غير متصل');
          failed++;
          done++;
          activeJobs.set(jobId, { status: 'running', total: linksData.length, done, succeeded, failed });
          continue;
        }

        const match = url.match(WA_INVITE_RE);
        if (!match) {
          await this._recordJoin(db, linkId, url, targetAccountId, 'failed', 'رابط غير صالح');
          failed++;
          done++;
          activeJobs.set(jobId, { status: 'running', total: linksData.length, done, succeeded, failed });
          continue;
        }

        const inviteCode = match[1];
        let errorMsg = null;
        let result = null;

        try {
          result = await sock.groupAcceptInvite(inviteCode);
        } catch (e) {
          errorMsg = e.message || 'خطأ غير معروف';
        }

        const success = result && !errorMsg;
        await this._recordJoin(
          db, linkId, url, targetAccountId,
          success ? 'joined' : 'failed',
          errorMsg || null
        );

        if (success) succeeded++; else failed++;

      } catch (err) {
        failed++;
        try {
          const db = await DatabaseManager.getAccountDB(sourceAccountId);
          await this._recordJoin(db, linkId, url, targetAccountId, 'failed', err.message);
        } catch { /* ignore */ }
      }

      done++;
      activeJobs.set(jobId, { status: 'running', total: linksData.length, done, succeeded, failed });

      // تأخير بين الانضمامات
      if (i < linksData.length - 1) {
        let delayMs = delaySeconds * 1000;
        if (randomDelay && randomDelayMax > delaySeconds) {
          delayMs += Math.floor(Math.random() * (randomDelayMax - delaySeconds) * 1000);
        }
        await new Promise(r => setTimeout(r, Math.max(delayMs, 3000)));
      }
    }

    activeJobs.set(jobId, { status: 'finished', total: linksData.length, done, succeeded, failed, finishedAt: new Date() });
    // تنظيف بعد 5 دقائق
    setTimeout(() => activeJobs.delete(jobId), 300_000);
  }

  async _recordJoin(db, linkId, url, accountId, status, failReason) {
    try {
      if (linkId) {
        await db.run(
          `UPDATE discovered_links SET status=$1, join_account_used=$2, updated_at=NOW(),
           join_attempts = join_attempts + 1,
           joined_at = CASE WHEN $1='joined' THEN NOW() ELSE joined_at END,
           join_fail_reason = $3
           WHERE id=$4`,
          [status, accountId, failReason, linkId]
        );
      }
      await db.run(
        `INSERT INTO join_history (url, account_id, status, fail_reason, attempted_at)
         VALUES ($1,$2,$3,$4,NOW())`,
        [url, accountId, status, failReason]
      );
    } catch { /* ignore */ }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  7. حالة وظيفة الانضمام
  // ══════════════════════════════════════════════════════════════════════════
  async getJobStatus(req, res) {
    const { jobId } = req.params;
    const job = activeJobs.get(jobId);
    if (!job) return res.json({ success: true, status: 'not_found' });
    res.json({ success: true, ...job });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  8. إضافة روابط يدوياً
  // ══════════════════════════════════════════════════════════════════════════
  async addLinks(req, res) {
    try {
      const { accountId, urls = [] } = req.body;

      if (!accountId) return res.status(400).json({ success: false, error: 'accountId مطلوب' });
      if (!urls || urls.length === 0) return res.status(400).json({ success: false, error: 'لا توجد روابط' });

      const db = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(db);

      let added = 0, skipped = 0;
      for (const rawUrl of urls) {
        const url = (rawUrl || '').trim();
        if (!url) { skipped++; continue; }

        const linkType = /chat\.whatsapp\.com/.test(url)  ? 'whatsapp_group'
                       : /wa\.me/.test(url)               ? 'whatsapp_group'
                       : /t\.me|telegram\.me/.test(url)   ? 'telegram_group'
                       : 'other';

        const result = await db.run(
          `INSERT INTO discovered_links (url, link_type, status, discovered_at, updated_at)
           VALUES ($1,$2,'new',NOW(),NOW())
           ON CONFLICT (url) DO NOTHING`,
          [url, linkType]
        ).catch(() => ({ rowCount: 0 }));

        if ((result?.rowCount || 0) > 0) added++; else skipped++;
      }

      res.json({
        success: true,
        added,
        skipped,
        message: `تمت إضافة ${added} رابط (${skipped} مكرر/غير صالح)`,
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  9. الوضع التلقائي — الحالة
  // ══════════════════════════════════════════════════════════════════════════
  async getAutoMode(req, res) {
    res.json({
      success: true,
      autoMode: {
        isRunning:  autoModeState.isRunning,
        startedAt:  autoModeState.startedAt,
        settings:   autoModeState.settings,
        stats:      autoModeState.stats,
      },
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  10. تشغيل الوضع التلقائي
  // ══════════════════════════════════════════════════════════════════════════
  async startAutoMode(req, res) {
    try {
      if (autoModeState.isRunning) {
        return res.json({ success: true, message: 'الوضع التلقائي يعمل بالفعل', alreadyRunning: true });
      }

      const {
        accountIds        = [],
        delaySeconds      = 30,
        randomDelay       = false,
        randomDelayMax    = 60,
        linkTypes         = ['whatsapp_group'],
        maxPerRun         = 20,
        intervalMinutes   = 5,
        distributionMode  = 'all',
        sourceAccountId,
      } = req.body;

      if (!sourceAccountId) {
        return res.status(400).json({ success: false, error: 'sourceAccountId مطلوب' });
      }

      // تحديث الإعدادات
      autoModeState.settings = {
        accountIds, delaySeconds, randomDelay, randomDelayMax,
        linkTypes, maxPerRun, intervalMinutes, distributionMode,
        sourceAccountId,
      };

      autoModeState.isRunning = true;
      autoModeState.startedAt = new Date().toISOString();

      // تشغيل الحلقة التلقائية
      const runAutoJoin = async () => {
        if (!autoModeState.isRunning) return;
        autoModeState.stats.runCount++;
        autoModeState.stats.lastRunAt = new Date().toISOString();

        try {
          const isAdmin = ['super_admin', 'admin'].includes(req.user?.role);
          const allAccounts = await this._getAllAccounts(req.user?.id, isAdmin);

          const srcAcc = allAccounts.find(a => a.id === sourceAccountId);
          if (!srcAcc) return;

          const db = await DatabaseManager.getAccountDB(sourceAccountId);
          await this._ensureTables(db);

          // جلب الروابط الجديدة
          const typeFilter = linkTypes.length > 0
            ? `AND link_type IN (${linkTypes.map((_, i) => `$${i + 2}`).join(',')})`
            : '';

          const newLinks = await db.all(
            `SELECT id, url, link_type FROM discovered_links
             WHERE status = 'new' ${typeFilter}
             ORDER BY discovered_at ASC LIMIT $1`,
            [maxPerRun, ...linkTypes]
          );

          if (newLinks.length === 0) return;

          // تحديد الحسابات المستخدمة
          const useAccountIds = accountIds.length > 0
            ? accountIds
            : allAccounts.map(a => a.id);

          const jobId = crypto.randomUUID();
          activeJobs.set(jobId, { status: 'running', total: newLinks.length, done: 0, isAutoMode: true });

          await this._runMultiJoin(
            sourceAccountId,
            newLinks.map(l => ({ id: l.id, url: l.url })),
            useAccountIds,
            { delaySeconds, randomDelay, randomDelayMax, distributionMode, jobId }
          );

          const job = activeJobs.get(jobId);
          if (job) {
            autoModeState.stats.totalJoined += job.succeeded || 0;
            autoModeState.stats.totalFailed += job.failed  || 0;
          }
        } catch (err) {
          console.error('[AutoMode] error:', err.message);
        }
      };

      // تشغيل أول مرة فوراً ثم بعد كل فترة
      runAutoJoin();
      autoModeState.intervalId = setInterval(runAutoJoin, intervalMinutes * 60 * 1000);

      res.json({ success: true, message: 'تم تشغيل الوضع التلقائي', settings: autoModeState.settings });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  11. إيقاف الوضع التلقائي
  // ══════════════════════════════════════════════════════════════════════════
  async stopAutoMode(req, res) {
    if (!autoModeState.isRunning) {
      return res.json({ success: true, message: 'الوضع التلقائي متوقف بالفعل' });
    }

    if (autoModeState.intervalId) {
      clearInterval(autoModeState.intervalId);
      autoModeState.intervalId = null;
    }

    autoModeState.isRunning = false;
    autoModeState.startedAt = null;

    res.json({ success: true, message: 'تم إيقاف الوضع التلقائي', stats: autoModeState.stats });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  12. إعدادات الوضع التلقائي
  // ══════════════════════════════════════════════════════════════════════════
  async getAutoSettings(req, res) {
    res.json({ success: true, settings: autoModeState.settings });
  }

  async updateAutoSettings(req, res) {
    const {
      accountIds, delaySeconds, randomDelay, randomDelayMax,
      linkTypes, maxPerRun, intervalMinutes, distributionMode, sourceAccountId,
    } = req.body;

    if (accountIds       !== undefined) autoModeState.settings.accountIds       = accountIds;
    if (delaySeconds     !== undefined) autoModeState.settings.delaySeconds     = delaySeconds;
    if (randomDelay      !== undefined) autoModeState.settings.randomDelay      = randomDelay;
    if (randomDelayMax   !== undefined) autoModeState.settings.randomDelayMax   = randomDelayMax;
    if (linkTypes        !== undefined) autoModeState.settings.linkTypes        = linkTypes;
    if (maxPerRun        !== undefined) autoModeState.settings.maxPerRun        = maxPerRun;
    if (intervalMinutes  !== undefined) autoModeState.settings.intervalMinutes  = intervalMinutes;
    if (distributionMode !== undefined) autoModeState.settings.distributionMode = distributionMode;
    if (sourceAccountId  !== undefined) autoModeState.settings.sourceAccountId  = sourceAccountId;

    res.json({ success: true, message: 'تم حفظ الإعدادات', settings: autoModeState.settings });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  13. حذف رابط واحد أو دفعة
  // ══════════════════════════════════════════════════════════════════════════
  async deleteLinks(req, res) {
    try {
      const { accountId, linkIds = [] } = req.body;
      if (!accountId || linkIds.length === 0) {
        return res.status(400).json({ success: false, error: 'accountId و linkIds مطلوبان' });
      }
      const db = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(db);

      const placeholders = linkIds.map((_, i) => `$${i + 1}`).join(',');
      const result = await db.run(
        `DELETE FROM discovered_links WHERE id IN (${placeholders})`,
        linkIds
      );
      const deleted = result?.rowCount || 0;
      res.json({ success: true, deleted, message: `تم حذف ${deleted} رابط` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  14. تحديث حالة رابط
  // ══════════════════════════════════════════════════════════════════════════
  async updateLinkStatus(req, res) {
    try {
      const { accountId, linkId } = req.params;
      const { status } = req.body;
      const validStatuses = ['new', 'joined', 'failed', 'disabled', 'blocked'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
      }
      const db = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(db);
      await db.run(
        `UPDATE discovered_links SET status=$1, updated_at=NOW() WHERE id=$2`,
        [status, linkId]
      );
      res.json({ success: true, message: 'تم تحديث الحالة' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

module.exports = new LinkJoinController();
