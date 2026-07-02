const { Pool } = require('pg');
const crypto = require('crypto');
const WhatsAppManager = require('../../bot/WhatsAppManager');

// ─── DB Pool (system-level, not per-account) ──────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

class PrivateCampaignController {

    // ── Ensure Tables Exist ────────────────────────────────────────────────────
    async ensureTables() {
        const client = await pool.connect();
        try {
            await client.query(`
                CREATE TABLE IF NOT EXISTS private_campaigns (
                    id                   TEXT PRIMARY KEY,
                    user_id              TEXT NOT NULL,
                    name                 TEXT NOT NULL,
                    status               TEXT NOT NULL DEFAULT 'draft',
                    message_text         TEXT NOT NULL,
                    media_url            TEXT,
                    media_type           TEXT,
                    target_groups_count  INTEGER DEFAULT 0,
                    accounts_count       INTEGER DEFAULT 0,
                    messages_per_account INTEGER DEFAULT 50,
                    interval_seconds     INTEGER DEFAULT 15,
                    start_time           TIMESTAMPTZ,
                    end_time             TIMESTAMPTZ,
                    sent_count           INTEGER DEFAULT 0,
                    failed_count         INTEGER DEFAULT 0,
                    total_targets        INTEGER DEFAULT 0,
                    created_at           TIMESTAMPTZ DEFAULT NOW(),
                    updated_at           TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS private_campaign_groups (
                    id           TEXT PRIMARY KEY,
                    campaign_id  TEXT NOT NULL REFERENCES private_campaigns(id) ON DELETE CASCADE,
                    account_id   TEXT NOT NULL,
                    group_jid    TEXT NOT NULL,
                    group_name   TEXT,
                    status       TEXT DEFAULT 'pending',
                    sent_at      TIMESTAMPTZ,
                    error_msg    TEXT,
                    created_at   TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS private_campaign_accounts (
                    id                 TEXT PRIMARY KEY,
                    campaign_id        TEXT NOT NULL REFERENCES private_campaigns(id) ON DELETE CASCADE,
                    account_id         TEXT NOT NULL,
                    messages_limit     INTEGER DEFAULT 50,
                    messages_sent      INTEGER DEFAULT 0,
                    messages_failed    INTEGER DEFAULT 0,
                    status             TEXT DEFAULT 'pending',
                    started_at         TIMESTAMPTZ,
                    completed_at       TIMESTAMPTZ,
                    created_at         TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            await client.query(`
                CREATE TABLE IF NOT EXISTS private_campaign_logs (
                    id           TEXT PRIMARY KEY,
                    campaign_id  TEXT NOT NULL REFERENCES private_campaigns(id) ON DELETE CASCADE,
                    account_id   TEXT,
                    level        TEXT DEFAULT 'info',
                    message      TEXT,
                    created_at   TIMESTAMPTZ DEFAULT NOW()
                )
            `);

            // Indexes
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pc_user   ON private_campaigns(user_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pc_status ON private_campaigns(status)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pcg_camp  ON private_campaign_groups(campaign_id, status)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pca_camp  ON private_campaign_accounts(campaign_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_pcl_camp  ON private_campaign_logs(campaign_id, created_at DESC)`);

        } finally {
            client.release();
        }
    }

    // ── Helper: log event ──────────────────────────────────────────────────────
    async _log(campaignId, level, message, accountId = null) {
        try {
            await pool.query(
                `INSERT INTO private_campaign_logs (id, campaign_id, account_id, level, message)
                 VALUES ($1,$2,$3,$4,$5)`,
                [crypto.randomUUID(), campaignId, accountId, level, message]
            );
        } catch (e) {
            console.error('[PrivateCampaignController] _log error:', e.message);
        }
    }

    // ── Helper: update counters ────────────────────────────────────────────────
    async _updateCounts(campaignId) {
        await pool.query(`
            UPDATE private_campaigns SET
                sent_count   = (SELECT COUNT(*) FROM private_campaign_groups WHERE campaign_id=$1 AND status='sent'),
                failed_count = (SELECT COUNT(*) FROM private_campaign_groups WHERE campaign_id=$1 AND status='failed'),
                updated_at   = NOW()
            WHERE id=$1
        `, [campaignId]);
    }

    // ── Create Campaign ────────────────────────────────────────────────────────
    async createCampaign(userId, {
        name, messageText, groupIds, accountIds,
        messagesPerAccount, intervalSeconds,
        startTime, endTime, autoStart,
        groupNamesByJid = {}   // [FIX-REAL-GROUP-SEND] اختياري: { [group_jid]: group_name }
    }) {
        await this.ensureTables();

        const campaignId = crypto.randomUUID();
        const totalTargets = Math.min(groupIds.length, accountIds.length * messagesPerAccount);

        // Distribute groups across accounts (round-robin)
        const groupAssignments = []; // [{groupId, accountId}]
        let accountIdx = 0;
        const accountMessageCount = {};
        accountIds.forEach(aid => { accountMessageCount[aid] = 0; });

        for (const gid of groupIds) {
            // Find next account that hasn't hit its limit
            let assigned = false;
            for (let i = 0; i < accountIds.length; i++) {
                const aid = accountIds[(accountIdx + i) % accountIds.length];
                if (accountMessageCount[aid] < messagesPerAccount) {
                    groupAssignments.push({ groupId: gid, accountId: aid });
                    accountMessageCount[aid]++;
                    accountIdx = (accountIdx + 1) % accountIds.length;
                    assigned = true;
                    break;
                }
            }
            if (!assigned) break; // All accounts at limit
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');

            // Insert campaign
            await client.query(
                `INSERT INTO private_campaigns
                    (id, user_id, name, status, message_text,
                     target_groups_count, accounts_count, messages_per_account,
                     interval_seconds, start_time, end_time, total_targets)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
                [
                    campaignId, userId, name,
                    autoStart ? 'running' : 'draft',
                    messageText,
                    groupIds.length, accountIds.length,
                    messagesPerAccount, intervalSeconds,
                    startTime, endTime, groupAssignments.length
                ]
            );

            // Insert group targets
            for (const { groupId, accountId } of groupAssignments) {
                await client.query(
                    `INSERT INTO private_campaign_groups (id, campaign_id, account_id, group_jid, group_name, status)
                     VALUES ($1,$2,$3,$4,$5,'pending')`,
                    [crypto.randomUUID(), campaignId, accountId, groupId, groupNamesByJid[groupId] || null]
                );
            }

            // Insert account entries
            for (const aid of accountIds) {
                await client.query(
                    `INSERT INTO private_campaign_accounts (id, campaign_id, account_id, messages_limit)
                     VALUES ($1,$2,$3,$4)`,
                    [crypto.randomUUID(), campaignId, aid, accountMessageCount[aid] || 0]
                );
            }

            await client.query('COMMIT');

            await this._log(campaignId, 'info',
                `✅ تم إنشاء الحملة. المجموعات: ${groupAssignments.length} | الحسابات: ${accountIds.length} | رسائل/حساب: ${messagesPerAccount}`
            );

            // Auto-start if requested
            if (autoStart) {
                // Non-blocking execution
                this._executeEngine(campaignId, userId, intervalSeconds, startTime, endTime)
                    .catch(e => console.error('[PrivateCampaign] Engine error:', e));
                await this._log(campaignId, 'info', '🚀 تم إطلاق الحملة تلقائياً');
            }

            return campaignId;
        } catch (e) {
            await client.query('ROLLBACK');
            throw e;
        } finally {
            client.release();
        }
    }

    // ── Start Campaign ─────────────────────────────────────────────────────────
    async startCampaign(campaignId, userId) {
        const res = await pool.query(
            `SELECT * FROM private_campaigns WHERE id=$1 AND user_id=$2`,
            [campaignId, userId]
        );
        const campaign = res.rows[0];
        if (!campaign) throw new Error('الحملة غير موجودة');
        if (campaign.status === 'running') return { success: true, message: 'الحملة نشطة بالفعل' };
        if (campaign.status === 'completed') throw new Error('الحملة مكتملة بالفعل');

        await pool.query(
            `UPDATE private_campaigns SET status='running', updated_at=NOW() WHERE id=$1`,
            [campaignId]
        );
        await this._log(campaignId, 'info', '▶️ تم تشغيل الحملة');

        // Start engine non-blocking
        this._executeEngine(
            campaignId, userId,
            campaign.interval_seconds,
            campaign.start_time,
            campaign.end_time
        ).catch(e => console.error('[PrivateCampaign] Engine error:', e));

        return { success: true, message: 'تم تشغيل الحملة' };
    }

    // ── Pause Campaign ─────────────────────────────────────────────────────────
    async pauseCampaign(campaignId, userId) {
        await pool.query(
            `UPDATE private_campaigns SET status='paused', updated_at=NOW()
             WHERE id=$1 AND user_id=$2`,
            [campaignId, userId]
        );
        await this._log(campaignId, 'warning', '⏸️ تم إيقاف الحملة مؤقتاً');
        return { success: true, message: 'تم إيقاف الحملة مؤقتاً' };
    }

    // ── Delete Campaign ────────────────────────────────────────────────────────
    async deleteCampaign(campaignId, userId) {
        await pool.query(
            `DELETE FROM private_campaigns WHERE id=$1 AND user_id=$2`,
            [campaignId, userId]
        );
    }

    // ── List Campaigns ─────────────────────────────────────────────────────────
    async listCampaigns(userId) {
        await this.ensureTables();
        const res = await pool.query(
            `SELECT * FROM private_campaigns WHERE user_id=$1 ORDER BY created_at DESC`,
            [userId]
        );
        return res.rows;
    }

    // ── Get Single Campaign ────────────────────────────────────────────────────
    async getCampaign(campaignId, userId) {
        const res = await pool.query(
            `SELECT * FROM private_campaigns WHERE id=$1 AND user_id=$2`,
            [campaignId, userId]
        );
        return res.rows[0] || null;
    }

    // ── Get Logs ───────────────────────────────────────────────────────────────
    async getCampaignLogs(campaignId, userId, limit = 100) {
        // Verify ownership
        const check = await pool.query(
            `SELECT id FROM private_campaigns WHERE id=$1 AND user_id=$2`,
            [campaignId, userId]
        );
        if (!check.rows[0]) return [];

        const res = await pool.query(
            `SELECT * FROM private_campaign_logs WHERE campaign_id=$1 ORDER BY created_at DESC LIMIT $2`,
            [campaignId, limit]
        );
        return res.rows.reverse(); // Chronological order
    }

    // ── Get Stats ──────────────────────────────────────────────────────────────
    async getStats(campaignId, userId) {
        const campaign = await this.getCampaign(campaignId, userId);
        if (!campaign) throw new Error('Campaign not found');

        const accs = await pool.query(
            `SELECT * FROM private_campaign_accounts WHERE campaign_id=$1`,
            [campaignId]
        );
        const groups = await pool.query(
            `SELECT status, COUNT(*) as cnt FROM private_campaign_groups
             WHERE campaign_id=$1 GROUP BY status`,
            [campaignId]
        );
        const groupMap = {};
        groups.rows.forEach(r => { groupMap[r.status] = parseInt(r.cnt); });

        return {
            campaign,
            accounts: accs.rows,
            groupStats: groupMap,
        };
    }

    // ════════════════════════════════════════════════════════════════════════
    // Express Route Handlers (req, res)
    // ────────────────────────────────────────────────────────────────────────
    // routes.js binds these methods directly as Express middleware, so each
    // one receives (req, res, next) from Express — NOT the plain (userId) /
    // (campaignId, userId) args the business-logic methods above expect.
    //
    // Previously routes.js pointed straight at the business-logic methods
    // (e.g. `listCampaigns.bind(...)`), so `userId` was actually bound to the
    // whole `req` object. `req` contains `req.socket`, a circular Node.js
    // Socket/HTTPParser structure, which crashed as soon as it hit
    // `pool.query(..., [userId])` → "TypeError: Converting circular
    // structure to JSON" (PrivateCampaignController.js:261).
    //
    // These thin handlers unwrap (req, res) into the correct plain
    // arguments and call the business-logic methods above, matching the
    // pattern used by CampaignController.
    // ════════════════════════════════════════════════════════════════════════

    async listCampaignsHandler(req, res) {
        try {
            const campaigns = await this.listCampaigns(req.user.id);
            res.json({ success: true, campaigns });
        } catch (error) {
            console.error('[PrivateCampaign] List Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getCampaignHandler(req, res) {
        try {
            const campaign = await this.getCampaign(req.params.id, req.user.id);
            if (!campaign) return res.status(404).json({ success: false, error: 'الحملة غير موجودة' });
            res.json({ success: true, campaign });
        } catch (error) {
            console.error('[PrivateCampaign] Get Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async createCampaignHandler(req, res) {
        try {
            const campaignId = await this.createCampaign(req.user.id, req.body);
            res.json({ success: true, campaignId });
        } catch (error) {
            console.error('[PrivateCampaign] Create Error:', error);
            res.status(500).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }

    async startCampaignHandler(req, res) {
        try {
            const result = await this.startCampaign(req.params.id, req.user.id);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[PrivateCampaign] Start Error:', error);
            res.status(400).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }

    async pauseCampaignHandler(req, res) {
        try {
            const result = await this.pauseCampaign(req.params.id, req.user.id);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('[PrivateCampaign] Pause Error:', error);
            res.status(400).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }

    async deleteCampaignHandler(req, res) {
        try {
            await this.deleteCampaign(req.params.id, req.user.id);
            res.json({ success: true });
        } catch (error) {
            console.error('[PrivateCampaign] Delete Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getCampaignLogsHandler(req, res) {
        try {
            const limit = parseInt(req.query.limit) || 100;
            const logs = await this.getCampaignLogs(req.params.id, req.user.id, limit);
            res.json({ success: true, logs });
        } catch (error) {
            console.error('[PrivateCampaign] Logs Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getStatsHandler(req, res) {
        try {
            const stats = await this.getStats(req.params.id, req.user.id);
            res.json({ success: true, ...stats });
        } catch (error) {
            console.error('[PrivateCampaign] Stats Error:', error);
            res.status(404).json({ success: false, error: error.message || 'Internal Server Error' });
        }
    }

    // ── Execution Engine ───────────────────────────────────────────────────────
    async _executeEngine(campaignId, userId, intervalSeconds, startTime, endTime) {
        const delay = ms => new Promise(r => setTimeout(r, ms));

        // Wait until start_time
        const now = Date.now();
        const start = new Date(startTime).getTime();
        if (start > now) {
            const waitMs = start - now;
            await this._log(campaignId, 'info',
                `⏳ في انتظار وقت البداية: ${Math.round(waitMs / 60000)} دقيقة`
            );
            await delay(waitMs);
        }

        await this._log(campaignId, 'info', '🔄 بدأ تنفيذ الحملة');

        // Main loop: fetch pending groups in batches
        while (true) {
            // Check campaign status
            const statusRes = await pool.query(
                `SELECT status, end_time FROM private_campaigns WHERE id=$1`,
                [campaignId]
            );
            const row = statusRes.rows[0];
            if (!row || row.status !== 'running') {
                await this._log(campaignId, 'info', `⏹️ توقف المحرك (الحالة: ${row?.status ?? 'غير موجود'})`);
                break;
            }

            // Check end_time
            if (endTime && new Date() > new Date(endTime)) {
                await pool.query(
                    `UPDATE private_campaigns SET status='completed', updated_at=NOW() WHERE id=$1`,
                    [campaignId]
                );
                await this._log(campaignId, 'success', '✅ اكتملت الحملة — انتهى وقت النهاية');
                break;
            }

            // Fetch one pending target
            const targetRes = await pool.query(
                `SELECT pcg.*, pca.account_id as a_id
                 FROM private_campaign_groups pcg
                 LEFT JOIN private_campaign_accounts pca
                   ON pca.campaign_id = pcg.campaign_id AND pca.account_id = pcg.account_id
                 WHERE pcg.campaign_id=$1 AND pcg.status='pending'
                 ORDER BY pcg.created_at ASC
                 LIMIT 1`,
                [campaignId]
            );

            if (targetRes.rows.length === 0) {
                // All sent
                await pool.query(
                    `UPDATE private_campaigns SET status='completed', updated_at=NOW() WHERE id=$1`,
                    [campaignId]
                );
                await this._log(campaignId, 'success', '🎉 تم إرسال جميع الرسائل بنجاح!');
                break;
            }

            const target = targetRes.rows[0];

            // Get message content
            const msgRes = await pool.query(
                `SELECT message_text FROM private_campaigns WHERE id=$1`,
                [campaignId]
            );
            const messageText = msgRes.rows[0]?.message_text || '';

            // Try to send
            try {
                // [FIX-REAL-GROUP-SEND] الهدف هنا دائماً مجموعة واتساب، لذا
                // يجب استخدام sendGroupMessage (تُلحق @g.us) وليس
                // sendTextMessage (كانت تُلحق @s.whatsapp.net خطأً وتحوّل
                // الإرسال إلى محادثة خاصة بدل نشر داخل المجموعة — وهذا كان
                // السبب الجذري لفشل كل عمليات النشر الفعلي بـ Timed Out).
                //
                // كذلك نتحقق دفاعياً أن group_jid المخزَّن هو معرّف واتساب
                // صالح فعلاً (رقمي وينتهي بـ @g.us أو رقمي خام قابل للإلحاق)
                // وليس UUID داخلياً تسرّب من قاعدة البيانات عن طريق الخطأ —
                // فهذا يفشل فوراً بخطأ واضح بدل الانتظار حتى Timed Out.
                const rawJid = String(target.group_jid || '');
                const isValidGroupIdentifier = /^[0-9]{5,}(-[0-9]+)?(@g\.us)?$/.test(rawJid);
                if (!isValidGroupIdentifier) {
                    throw new Error(
                        `معرّف المجموعة غير صالح (group_jid="${rawJid}") — يبدو أنه معرّف داخلي وليس معرّف واتساب حقيقي. يجب اختيار المجموعة من جديد.`
                    );
                }

                await WhatsAppManager.sendGroupMessage(target.account_id, rawJid, { text: messageText });

                await pool.query(
                    `UPDATE private_campaign_groups SET status='sent', sent_at=NOW() WHERE id=$1`,
                    [target.id]
                );
                await pool.query(
                    `UPDATE private_campaign_accounts SET messages_sent=messages_sent+1 WHERE campaign_id=$1 AND account_id=$2`,
                    [campaignId, target.account_id]
                );
                await this._log(campaignId, 'success',
                    `✅ أُرسلت إلى: ${target.group_name || target.group_jid} (عبر ${target.account_id})`,
                    target.account_id
                );
            } catch (err) {
                await pool.query(
                    `UPDATE private_campaign_groups SET status='failed', error_msg=$2 WHERE id=$1`,
                    [target.id, err.message]
                );
                await pool.query(
                    `UPDATE private_campaign_accounts SET messages_failed=messages_failed+1 WHERE campaign_id=$1 AND account_id=$2`,
                    [campaignId, target.account_id]
                );
                await this._log(campaignId, 'error',
                    `❌ فشل الإرسال إلى ${target.group_name || target.group_jid}: ${err.message}`,
                    target.account_id
                );
            }

            // Update campaign counters
            await this._updateCounts(campaignId);

            // Wait interval
            const waitMs = intervalSeconds * 1000;
            await delay(waitMs);
        }
    }
}

module.exports = new PrivateCampaignController();

