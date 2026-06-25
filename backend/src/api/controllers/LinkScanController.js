'use strict';
/**
 * LinkScanController — تحكم في البحث التلقائي والانضمام
 *
 * Endpoints الجديدة:
 *   POST   /accounts/:accountId/links/scan/start
 *   POST   /accounts/:accountId/links/scan/stop
 *   GET    /accounts/:accountId/links/scan/status
 *   GET    /links/scan/all-status
 *   POST   /links/scan/start-all
 *
 *   GET    /accounts/:accountId/links/discovered
 *   GET    /accounts/:accountId/links/discovered/stats
 *   DELETE /accounts/:accountId/links/discovered/duplicates
 *   DELETE /accounts/:accountId/links/discovered/:linkId
 *   PATCH  /accounts/:accountId/links/discovered/:linkId/status
 *
 *   POST   /accounts/:accountId/links/discovered/join
 *   POST   /links/discovered/join-multi (لعدة حسابات)
 *   POST   /accounts/:accountId/links/discovered/import
 *
 *   GET    /accounts/:accountId/links/join-history
 *   GET    /links/join-history/all
 *
 *   GET    /accounts/:accountId/links/join-settings
 *   PUT    /accounts/:accountId/links/join-settings
 */

const LinkScanEngine  = require('../services/LinkScanEngine');
const DatabaseManager = require('../../database/DatabaseManager');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const crypto          = require('crypto');

// نمط روابط واتساب لاستخراج كود الدعوة
const WA_INVITE_RE = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/;

class LinkScanController {

  // ══════════════════════════════════════════════════════════════════════════
  //  جداول قاعدة البيانات
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

    await accountDB.run(`
      CREATE TABLE IF NOT EXISTS join_history (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        link_id       UUID REFERENCES discovered_links(id) ON DELETE CASCADE,
        url           TEXT NOT NULL,
        account_id    TEXT NOT NULL,
        status        TEXT DEFAULT 'pending',
        result_msg    TEXT,
        fail_reason   TEXT,
        attempted_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    await accountDB.run(`
      CREATE TABLE IF NOT EXISTS link_join_settings (
        id                      TEXT PRIMARY KEY DEFAULT 'default',
        delay_between_joins_sec INTEGER DEFAULT 30,
        random_delay_enabled    BOOLEAN DEFAULT false,
        random_delay_max_sec    INTEGER DEFAULT 60,
        max_retries             INTEGER DEFAULT 2,
        max_joins_per_hour      INTEGER DEFAULT 20,
        max_joins_per_day       INTEGER DEFAULT 100,
        skip_duplicates         BOOLEAN DEFAULT true,
        skip_disabled           BOOLEAN DEFAULT true,
        updated_at              TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    const alterCols = [
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS group_name TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_account_used TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS joined_at TIMESTAMPTZ`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_fail_reason TEXT`,
      `ALTER TABLE discovered_links ADD COLUMN IF NOT EXISTS join_attempts INTEGER DEFAULT 0`,
    ];
    for (const sql of alterCols) {
      await accountDB.run(sql).catch(() => {});
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  بدء الفحص
  // ══════════════════════════════════════════════════════════════════════════
  async startScan(req, res) {
    try {
      const { accountId } = req.params;
      const { accountIds = [] } = req.body;
      const ids = accountIds.length > 0 ? accountIds : [accountId];

      const started = await LinkScanEngine.startScan(ids);
      res.json({
        success: true,
        message: `بدأ الفحص لـ ${started.length} حساب`,
        started,
      });
    } catch (err) {
      console.error('StartScan error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  إيقاف الفحص
  // ══════════════════════════════════════════════════════════════════════════
  async stopScan(req, res) {
    try {
      const { accountId } = req.params;
      const stopped = LinkScanEngine.stopScan(accountId);
      res.json({ success: true, stopped, message: stopped ? 'تم إيقاف الفحص' : 'لا يوجد فحص نشط' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  حالة الفحص
  // ══════════════════════════════════════════════════════════════════════════
  async getScanStatus(req, res) {
    try {
      const { accountId } = req.params;
      const job = LinkScanEngine.getJob(accountId);
      res.json({ success: true, job });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async getAllScanStatus(req, res) {
    try {
      const jobs = LinkScanEngine.getAllJobs();
      res.json({ success: true, jobs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async startScanAll(req, res) {
    try {
      const { query } = require('../../lib/postgres');
      const rows = await query(`
        SELECT id FROM accounts WHERE status = 'connected' AND user_id = $1
      `, [req.user?.id || '']).catch(() => ({ rows: [] }));

      const ids = rows.rows.map(r => r.id);
      if (ids.length === 0) {
        return res.status(400).json({ success: false, error: 'لا توجد حسابات متصلة' });
      }

      const started = await LinkScanEngine.startScan(ids);
      res.json({ success: true, message: `بدأ الفحص لـ ${started.length} حساب`, started });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  جلب الروابط المكتشفة
  // ══════════════════════════════════════════════════════════════════════════
  async getDiscoveredLinks(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const limit    = Math.min(parseInt(req.query.limit) || 200, 1000);
      const status   = req.query.status    || null;
      const linkType = req.query.linkType  || null;
      const search   = req.query.search    || null;
      const sortBy   = ['discovered_at','status','link_type','join_attempts'].includes(req.query.sortBy)
                       ? req.query.sortBy : 'discovered_at';
      const sortDir  = req.query.sortDir === 'ASC' ? 'ASC' : 'DESC';

      const conditions = ['1=1'];
      const params = [];
      let pIdx = 1;

      const add = (cond, val) => {
        conditions.push(cond.replace('?', `$${pIdx++}`));
        params.push(val);
      };

      if (status)   add(`status = ?`, status);
      if (linkType) add(`link_type = ?`, linkType);
      if (search) {
        conditions.push(`(url ILIKE $${pIdx} OR group_name ILIKE $${pIdx+1})`);
        params.push(`%${search}%`, `%${search}%`);
        pIdx += 2;
      }

      const where = conditions.join(' AND ');
      params.push(limit);

      const links = await accountDB.all(
        `SELECT * FROM discovered_links WHERE ${where}
         ORDER BY ${sortBy} ${sortDir} LIMIT $${pIdx}`,
        params
      );

      res.json({ success: true, links, count: links.length });
    } catch (err) {
      console.error('GetDiscoveredLinks error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  إحصائيات الروابط المكتشفة
  // ══════════════════════════════════════════════════════════════════════════
  async getDiscoveredStats(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const [
        total, byStatus, byType, duplicates, recent,
        joinedToday, failedToday,
      ] = await Promise.all([
        accountDB.get(`SELECT COUNT(*) AS cnt FROM discovered_links`),
        accountDB.all(`SELECT status, COUNT(*) AS cnt FROM discovered_links GROUP BY status`),
        accountDB.all(`SELECT link_type, COUNT(*) AS cnt FROM discovered_links GROUP BY link_type ORDER BY cnt DESC`),
        accountDB.get(`SELECT COUNT(*) AS cnt FROM (
          SELECT url, COUNT(*) AS c FROM discovered_links GROUP BY url HAVING c > 1
        ) t`),
        accountDB.get(`SELECT discovered_at FROM discovered_links ORDER BY discovered_at DESC LIMIT 1`),
        accountDB.get(`SELECT COUNT(*) AS cnt FROM discovered_links WHERE status='joined' AND joined_at >= NOW() - INTERVAL '1 day'`),
        accountDB.get(`SELECT COUNT(*) AS cnt FROM discovered_links WHERE status='failed' AND updated_at >= NOW() - INTERVAL '1 day'`),
      ]);

      const statusMap = {};
      (byStatus || []).forEach(r => { statusMap[r.status] = r.cnt; });

      // إحصائيات مهمة الفحص
      const scanJob = LinkScanEngine.getJob(accountId);

      res.json({
        success: true,
        stats: {
          total:          total?.cnt || 0,
          new:            statusMap['new']     || 0,
          joined:         statusMap['joined']  || 0,
          failed:         statusMap['failed']  || 0,
          disabled:       statusMap['disabled']|| 0,
          blocked:        statusMap['blocked'] || 0,
          duplicates:     duplicates?.cnt || 0,
          lastDiscovered: recent?.discovered_at || null,
          byType:         byType || [],
          joinedToday:    joinedToday?.cnt || 0,
          failedToday:    failedToday?.cnt || 0,
          scan:           scanJob,
        },
      });
    } catch (err) {
      console.error('GetDiscoveredStats error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  حذف المكرر
  // ══════════════════════════════════════════════════════════════════════════
  async deleteDuplicates(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      // احتفظ بأقدم سجل لكل URL، احذف الباقي
      const result = await accountDB.run(`
        DELETE FROM discovered_links
        WHERE id NOT IN (
          SELECT MIN(id::text)::uuid FROM discovered_links GROUP BY url
        )
      `);

      const deleted = result?.rowCount || result?.changes || 0;
      res.json({ success: true, deleted, message: `تم حذف ${deleted} رابط مكرر` });
    } catch (err) {
      console.error('DeleteDuplicates error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  حذف رابط
  // ══════════════════════════════════════════════════════════════════════════
  async deleteDiscoveredLink(req, res) {
    try {
      const { accountId, linkId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await accountDB.run(`DELETE FROM join_history WHERE link_id = $1`, [linkId]).catch(() => {});
      await accountDB.run(`DELETE FROM discovered_links WHERE id = $1`, [linkId]);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  تحديث حالة رابط
  // ══════════════════════════════════════════════════════════════════════════
  async updateLinkStatus(req, res) {
    try {
      const { accountId, linkId } = req.params;
      const { status } = req.body;
      const validStatuses = ['new', 'joined', 'failed', 'disabled', 'blocked'];
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
      }
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await accountDB.run(
        `UPDATE discovered_links SET status = $1, updated_at = NOW() WHERE id = $2`,
        [status, linkId]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  الانضمام للروابط المكتشفة
  // ══════════════════════════════════════════════════════════════════════════
  async joinDiscoveredLinks(req, res) {
    try {
      const { accountId } = req.params;
      const {
        linkIds          = [],
        accountIds       = [],
        delaySeconds     = 30,
        randomDelay      = false,
        randomDelayMax   = 60,
        distributionMode = 'single',
      } = req.body;

      if (!linkIds || linkIds.length === 0) {
        return res.status(400).json({ success: false, error: 'لم يتم تحديد أي روابط' });
      }

      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const placeholders = linkIds.map((_, i) => `$${i + 1}`).join(',');
      const links = await accountDB.all(
        `SELECT id, url, link_type, status FROM discovered_links WHERE id IN (${placeholders})`,
        linkIds
      );

      if (links.length === 0) {
        return res.status(404).json({ success: false, error: 'الروابط غير موجودة' });
      }

      const effectiveAccountIds = accountIds.length > 0 ? accountIds : [accountId];

      // تشغيل عملية الانضمام في الخلفية
      const jobId = crypto.randomUUID();
      this._runJoinJob(accountId, links, effectiveAccountIds, {
        delaySeconds, randomDelay, randomDelayMax, distributionMode, jobId,
      }).catch(err => console.error('[JoinJob] Error:', err));

      res.json({
        success: true,
        jobId,
        message: `جاري الانضمام لـ ${links.length} رابط`,
        linksCount: links.length,
        accountsCount: effectiveAccountIds.length,
      });
    } catch (err) {
      console.error('JoinDiscoveredLinks error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  تنفيذ عملية الانضمام في الخلفية
  // ══════════════════════════════════════════════════════════════════════════
  async _runJoinJob(sourceAccountId, links, accountIds, options) {
    const { delaySeconds, randomDelay, randomDelayMax, distributionMode, jobId } = options;
    const accountDB = await DatabaseManager.getAccountDB(sourceAccountId);
    const io = LinkScanEngine._io;

    const emitProgress = (data) => {
      if (io) io.emit(`link_join_${sourceAccountId}`, { jobId, ...data });
    };

    emitProgress({ status: 'running', total: links.length, done: 0 });

    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const targetAccountId = accountIds[i % accountIds.length];

      try {
        const sock = WhatsAppManager.getSocket(targetAccountId);
        if (!sock) {
          await this._recordJoin(accountDB, link.id, link.url, targetAccountId, 'failed', 'الحساب غير متصل');
          continue;
        }

        // استخراج كود الدعوة
        const match = link.url.match(WA_INVITE_RE);
        if (!match) {
          await this._recordJoin(accountDB, link.id, link.url, targetAccountId, 'failed', 'رابط غير صالح');
          continue;
        }

        const inviteCode = match[1];
        let result = null;
        let errorMsg = null;

        try {
          result = await sock.groupAcceptInvite(inviteCode);
        } catch (joinErr) {
          errorMsg = joinErr.message || 'خطأ في الانضمام';
        }

        const success = result && !errorMsg;
        await this._recordJoin(
          accountDB, link.id, link.url, targetAccountId,
          success ? 'joined' : 'failed',
          errorMsg || null
        );

        emitProgress({
          status: 'running',
          total: links.length,
          done: i + 1,
          lastUrl: link.url,
          lastSuccess: success,
          lastError: errorMsg,
        });

      } catch (err) {
        await this._recordJoin(accountDB, link.id, link.url, targetAccountId, 'failed', err.message).catch(() => {});
      }

      // تأخير بين الروابط
      if (i < links.length - 1) {
        let delay = delaySeconds * 1000;
        if (randomDelay) {
          delay += Math.floor(Math.random() * (randomDelayMax - delaySeconds) * 1000);
        }
        await new Promise(r => setTimeout(r, Math.max(delay, 3000)));
      }
    }

    emitProgress({ status: 'finished', total: links.length, done: links.length });
  }

  async _recordJoin(accountDB, linkId, url, accountId, status, failReason) {
    try {
      await accountDB.run(
        `UPDATE discovered_links SET status = $1, join_account_used = $2, updated_at = NOW(),
         join_attempts = join_attempts + 1,
         joined_at = CASE WHEN $1 = 'joined' THEN NOW() ELSE joined_at END,
         join_fail_reason = $3
         WHERE id = $4`,
        [status, accountId, failReason || null, linkId]
      );
      await accountDB.run(
        `INSERT INTO join_history (url, account_id, status, fail_reason, attempted_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [url, accountId, status, failReason || null]
      ).catch(() => {});
    } catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  استيراد روابط من ملف
  // ══════════════════════════════════════════════════════════════════════════
  async importLinks(req, res) {
    try {
      const { accountId } = req.params;
      const { links = [], raw = '' } = req.body;

      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const urlList = [...links];

      // استخراج روابط من نص خام
      if (raw) {
        const waPattern = /https?:\/\/chat\.whatsapp\.com\/[A-Za-z0-9_-]{10,}/g;
        const tgPattern = /https?:\/\/t\.me\/[A-Za-z0-9_+]{3,}/g;
        const found1 = raw.match(waPattern) || [];
        const found2 = raw.match(tgPattern) || [];
        urlList.push(...found1, ...found2);
      }

      let imported = 0, duplicates = 0;

      for (const url of urlList) {
        if (!url || typeof url !== 'string') continue;
        const linkType = /chat\.whatsapp\.com/.test(url) ? 'whatsapp_group'
                       : /t\.me/.test(url) ? 'telegram_group' : 'other';
        try {
          await accountDB.run(
            `INSERT INTO discovered_links (url, link_type, discovered_by_account, status, discovered_at, updated_at)
             VALUES ($1, $2, $3, 'new', NOW(), NOW())
             ON CONFLICT (url) DO NOTHING`,
            [url.trim(), linkType, accountId]
          );
          imported++;
        } catch (e) {
          if (e.message?.includes('duplicate') || e.message?.includes('unique')) duplicates++;
        }
      }

      res.json({
        success: true,
        imported,
        duplicates,
        message: `تم استيراد ${imported} رابط (${duplicates} مكرر تم تجاهله)`,
      });
    } catch (err) {
      console.error('ImportLinks error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  سجل الانضمام
  // ══════════════════════════════════════════════════════════════════════════
  async getJoinHistory(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const limit = Math.min(parseInt(req.query.limit) || 100, 500);
      const history = await accountDB.all(
        `SELECT jh.*, dl.link_type, dl.group_name
         FROM join_history jh
         LEFT JOIN discovered_links dl ON dl.url = jh.url
         ORDER BY jh.attempted_at DESC
         LIMIT $1`,
        [limit]
      );

      res.json({ success: true, history, count: history.length });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  إعدادات الانضمام
  // ══════════════════════════════════════════════════════════════════════════
  async getJoinSettings(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      let settings = await accountDB.get(`SELECT * FROM link_join_settings WHERE id = 'default'`);
      if (!settings) {
        await accountDB.run(`INSERT INTO link_join_settings (id) VALUES ('default') ON CONFLICT DO NOTHING`);
        settings = await accountDB.get(`SELECT * FROM link_join_settings WHERE id = 'default'`);
      }
      res.json({ success: true, settings });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  async updateJoinSettings(req, res) {
    try {
      const { accountId } = req.params;
      const {
        delay_between_joins_sec = 30,
        random_delay_enabled    = false,
        random_delay_max_sec    = 60,
        max_retries             = 2,
        max_joins_per_hour      = 20,
        max_joins_per_day       = 100,
        skip_duplicates         = true,
        skip_disabled           = true,
      } = req.body;

      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      await accountDB.run(
        `INSERT INTO link_join_settings
         (id, delay_between_joins_sec, random_delay_enabled, random_delay_max_sec,
          max_retries, max_joins_per_hour, max_joins_per_day, skip_duplicates, skip_disabled, updated_at)
         VALUES ('default', $1,$2,$3,$4,$5,$6,$7,$8, NOW())
         ON CONFLICT (id) DO UPDATE SET
           delay_between_joins_sec = EXCLUDED.delay_between_joins_sec,
           random_delay_enabled    = EXCLUDED.random_delay_enabled,
           random_delay_max_sec    = EXCLUDED.random_delay_max_sec,
           max_retries             = EXCLUDED.max_retries,
           max_joins_per_hour      = EXCLUDED.max_joins_per_hour,
           max_joins_per_day       = EXCLUDED.max_joins_per_day,
           skip_duplicates         = EXCLUDED.skip_duplicates,
           skip_disabled           = EXCLUDED.skip_disabled,
           updated_at              = NOW()`,
        [delay_between_joins_sec, random_delay_enabled, random_delay_max_sec,
         max_retries, max_joins_per_hour, max_joins_per_day, skip_duplicates, skip_disabled]
      );

      res.json({ success: true, message: 'تم حفظ إعدادات الانضمام' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  تصدير الروابط المكتشفة CSV
  // ══════════════════════════════════════════════════════════════════════════
  async exportDiscoveredCSV(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const links = await accountDB.all(
        `SELECT url, group_name, link_type, status, join_attempts, discovered_at
         FROM discovered_links ORDER BY discovered_at DESC LIMIT 10000`
      );

      const header = 'URL,GroupName,Type,Status,JoinAttempts,DiscoveredAt\n';
      const rows = links.map(l =>
        [l.url, `"${(l.group_name||'').replace(/"/g,'""')}"`, l.link_type, l.status, l.join_attempts, l.discovered_at].join(',')
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename=discovered_links_${accountId}.csv`);
      res.send('\uFEFF' + header + rows);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  تنظيف الروابط المعطلة/القديمة
  // ══════════════════════════════════════════════════════════════════════════
  async cleanupDisabledLinks(req, res) {
    try {
      const { accountId } = req.params;
      const accountDB = await DatabaseManager.getAccountDB(accountId);
      await this._ensureTables(accountDB);

      const result = await accountDB.run(
        `DELETE FROM discovered_links WHERE status IN ('disabled', 'blocked') AND updated_at < NOW() - INTERVAL '7 days'`
      );
      const deleted = result?.rowCount || result?.changes || 0;
      res.json({ success: true, deleted, message: `تم حذف ${deleted} رابط معطل قديم` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

module.exports = new LinkScanController();
