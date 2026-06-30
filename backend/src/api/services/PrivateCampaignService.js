const { Pool } = require('pg');
const crypto = require('crypto');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const { ProtectionService } = require('./ProtectionService');

// ─── DB Pool (system-level, not per-account) ──────────────────────────────────
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL?.includes('railway') ? { rejectUnauthorized: false } : false,
});

class PrivateCampaignService {

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
            console.error('[PrivateCampaignService] _log error:', e.message);
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
        startTime, endTime, autoStart
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
                    `INSERT INTO private_campaign_groups (id, campaign_id, account_id, group_jid, status)
                     VALUES ($1,$2,$3,$4,'pending')`,
                    [crypto.randomUUID(), campaignId, accountId, groupId]
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

        // [FIX-20] بدلاً من setTimeout loop، نُضيف كل رسالة كمهمة مستقلة في QueueManager
        // هذا يضمن: استمرارية بعد الـ restart + إمكانية الإيقاف + مراقبة التقدم
        try {
            const QueueManager = require('../../lib/QueueManager');

            // جلب جميع الأهداف المعلّقة
            const targetsRes = await pool.query(
                `SELECT pcg.*, pca.account_id as a_id
                 FROM private_campaign_groups pcg
                 LEFT JOIN private_campaign_accounts pca
                   ON pca.campaign_id = pcg.campaign_id
                 WHERE pcg.campaign_id=$1 AND pcg.status='pending'
                 ORDER BY pcg.created_at ASC`,
                [campaignId]
            );

            const targets     = targetsRes.rows;
            const intervalMs  = (campaign.interval_seconds || 5) * 1000;
            const messageText = campaign.message_text || '';

            // حساب تأخير بدء الإرسال إذا كان start_time في المستقبل
            const startDelay = Math.max(0, new Date(campaign.start_time).getTime() - Date.now());

            // [البند 1+2] فاصل عشوائي (Jitter) بدل الفاصل الرياضي الثابت 100%
            // (delayMs = i * intervalMs كان نمطاً منتظماً يسهل اكتشافه). نحافظ
            // على الترتيب التصاعدي العام (تراكمي) لكن مع تباين ±40% حول القيمة
            // الأساسية، بما يطابق صيغة baseDelay + random(0..40%) المطلوبة.
            let cumulativeDelay = startDelay;
            let enqueuedCount = 0;
            for (let i = 0; i < targets.length; i++) {
                const target = targets[i];

                if (i > 0) {
                    const jitterSpan = intervalMs * 0.4;
                    const jitter = Math.random() * jitterSpan;
                    cumulativeDelay += intervalMs + jitter - (jitterSpan / 2); // متمركز حول intervalMs
                }
                const delayMs = Math.max(0, Math.round(cumulativeDelay));

                await QueueManager.enqueuePrivateCampaignMessage(
                    target.account_id,
                    campaignId,
                    {
                        groupId:     target.group_jid,
                        groupName:   target.group_name,
                        accountId:   target.account_id,
                        targetRowId: target.id,
                        message:     messageText,
                    },
                    delayMs
                );
                enqueuedCount++;
            }

            await this._log(campaignId, 'info',
                `📬 تم إضافة ${enqueuedCount} رسالة إلى Queue (فاصل ${campaign.interval_seconds}ث)`
            );
        } catch (queueErr) {
            // Fallback: إذا فشل QueueManager، استخدم المحرك القديم
            console.warn('[PrivateCampaign] QueueManager unavailable, falling back to engine:', queueErr.message);
            this._executeEngine(
                campaignId, userId,
                campaign.interval_seconds,
                campaign.start_time,
                campaign.end_time
            ).catch(e => console.error('[PrivateCampaign] Engine error:', e));
        }

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

        // [FIX-20] إلغاء المهام المؤجلة في Queue
        try {
            const QueueManager = require('../../lib/QueueManager');
            const cancelled = await QueueManager.cancelCampaignJobs(campaignId);
            if (cancelled > 0) {
                await this._log(campaignId, 'info', `🗑️ تم إلغاء ${cancelled} رسالة معلّقة من Queue`);
            }
        } catch (_) {}

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

    // ── [FIX-20] Single Message Executor — يُستدعى من QueueManager ─────────────
    /**
     * تنفيذ إرسال رسالة واحدة — الـ handler المُسجَّل في QueueManager
     * بدلاً من setTimeout داخل loop
     */
    async executeSingleMessage(accountId, campaignId, payload) {
        const { groupId, groupName, targetRowId, message } = payload;

        // تحقق من حالة الحملة قبل الإرسال (قد تكون مُوقَفة)
        const statusRes = await pool.query(
            `SELECT status, user_id FROM private_campaigns WHERE id=$1`,
            [campaignId]
        );
        const campaignStatus = statusRes.rows[0]?.status;
        const campaignUserId = statusRes.rows[0]?.user_id;

        if (campaignStatus !== 'running') {
            console.log(`[PrivateCampaign] Skipping job — campaign ${campaignId} status: ${campaignStatus}`);
            return; // المهمة تُكمل بنجاح (لا retry) لأن الإيقاف متعمَّد
        }

        // [البند 3] لا نرسل من حساب موقوف تلقائياً (محظور/متجاوز عتبة الأخطاء) —
        // وإن كان كذلك، نُلغي كل المهام المتبقية للحملة بدل تركها تفشل واحدة واحدة
        if (campaignUserId && await ProtectionService.getInstance().isSuspended(campaignUserId, accountId)) {
            await pool.query(
                `UPDATE private_campaigns SET status='paused', updated_at=NOW() WHERE id=$1`,
                [campaignId]
            );
            await this._log(campaignId, 'error',
                `🚫 الحساب ${accountId} موقوف تلقائياً (حماية) — تم إيقاف الحملة وإلغاء كل المهام المتبقية`,
                accountId
            );
            try {
                const QueueManager = require('../../lib/QueueManager');
                await QueueManager.cancelCampaignJobs(campaignId);
            } catch (_) {}
            return; // اكتمال "ناجح" للمهمة الحالية — التوقف متعمَّد وليس فشلاً يستدعي retry
        }

        // محاولة الإرسال — [البند 1] عبر sendMessageSafe المحمي حصرياً، مع تمرير
        // operationType='private' صراحة (الحملات الخاصة دوماً private) وtaskId
        // لربطها بـ SmartRetry الخاص بـ ProtectionService
        try {
            await WhatsAppManager.sendMessageSafe(accountId, groupId, { text: message }, {
                operationType: 'private',
                taskId: targetRowId || `${campaignId}:${groupId}`,
            });

            // تحديث حالة الهدف → sent
            if (targetRowId) {
                await pool.query(
                    `UPDATE private_campaign_groups SET status='sent', sent_at=NOW() WHERE id=$1`,
                    [targetRowId]
                );
                await pool.query(
                    `UPDATE private_campaign_accounts SET messages_sent=messages_sent+1
                     WHERE campaign_id=$1 AND account_id=$2`,
                    [campaignId, accountId]
                );
            }

            await this._log(campaignId, 'success',
                `✅ أُرسلت إلى: ${groupName || groupId} (عبر ${accountId})`,
                accountId
            );
        } catch (err) {
            // تحديث حالة الهدف → failed
            if (targetRowId) {
                await pool.query(
                    `UPDATE private_campaign_groups SET status='failed', error_msg=$2 WHERE id=$1`,
                    [targetRowId, err.message]
                );
                await pool.query(
                    `UPDATE private_campaign_accounts SET messages_failed=messages_failed+1
                     WHERE campaign_id=$1 AND account_id=$2`,
                    [campaignId, accountId]
                );
            }

            await this._log(campaignId, 'error',
                `❌ فشل الإرسال إلى ${groupName || groupId}: ${err.message}`,
                accountId
            );

            // [البند 8] لا داعي لإعادة المحاولة عبر BullMQ إن كان السبب تعليق الحساب —
            // ProtectionService تكفّل بذلك بالفعل (recordFailure استدعت suspendAccount)
            if (err.protectionReason === 'account_suspended') {
                return; // لا نرمي الخطأ → لا retry إضافي من BullMQ على حساب محظور
            }

            throw err; // إعادة الرمي لـ BullMQ كي يُعيد المحاولة (attempts: 3) للأخطاء العادية فقط
        }

        // تحديث العدادات الإجمالية
        await this._updateCounts(campaignId);
    }

    // ── Execution Engine (Legacy Fallback) ────────────────────────────────────
    // يُستخدم فقط كـ fallback عندما يكون QueueManager غير متاح
    async _executeEngine(campaignId, userId, intervalSeconds, startTime, endTime) {
        // [البند 1+2] احتفظنا بـ delay() كأداة عامة وحيدة، لكنها الآن تُستخدم فقط
        // لانتظار "وقت البداية" (start_time) — وهو انتظار شرعي وليس تأخيراً بين
        // رسائل، وليس بديلاً عن safeDelay المستخدم بين كل رسالة وأخرى أدناه.
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

            // [البند 3] لا نرسل من حساب موقوف تلقائياً — نوقف الحملة كاملةً بدل
            // المحاولة بلا فائدة على حساب محظور
            if (await ProtectionService.getInstance().isSuspended(userId, target.account_id)) {
                await pool.query(
                    `UPDATE private_campaigns SET status='paused', updated_at=NOW() WHERE id=$1`,
                    [campaignId]
                );
                await this._log(campaignId, 'error',
                    `🚫 الحساب ${target.account_id} موقوف تلقائياً (حماية) — تم إيقاف الحملة`,
                    target.account_id
                );
                break;
            }

            // Get message content
            const msgRes = await pool.query(
                `SELECT message_text FROM private_campaigns WHERE id=$1`,
                [campaignId]
            );
            const messageText = msgRes.rows[0]?.message_text || '';

            // Try to send — [البند 1] عبر sendMessageSafe المحمي حصرياً
            try {
                await WhatsAppManager.sendMessageSafe(target.account_id, target.group_jid, { text: messageText }, {
                    operationType: 'private',
                    taskId: target.id,
                });

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

            // [البند 1+2] تأخير عشوائي آمن بدل intervalSeconds الثابت — مرتبط
            // بإعدادات الحماية الخاصة بالمستخدم (يضمن حداً أدنى معقولاً أيضاً
            // حتى لو كان intervalSeconds المُدخل صغيراً جداً)
            const minWaitMs = Math.max(0, intervalSeconds * 1000);
            await Promise.all([
                ProtectionService.getInstance().safeDelay(userId, 'private'),
                delay(minWaitMs * 0.5), // يحترم رغبة المستخدم بحد أدنى تقريبي دون أن يكون صارماً/ثابتاً 100%
            ]);
        }
    }
}

module.exports = new PrivateCampaignService();

