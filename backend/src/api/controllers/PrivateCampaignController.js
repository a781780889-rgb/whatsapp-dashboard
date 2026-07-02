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

    // ── [فلتر السعودية] هل رقم العضو سعودي (+966)؟ ─────────────────────────────
    //    jid على شكل "9665xxxxxxxx@s.whatsapp.net" أو "+9665xxxxxxxx@..."
    //    (نفس منطق LivePublishService._isSaudiNumber، مكرَّر هنا عمداً لعدم
    //    إدخال اعتمادية جديدة بين الخدمتين).
    _isSaudiNumber(jidOrPhone) {
        if (!jidOrPhone) return false;
        const raw = String(jidOrPhone).split('@')[0].replace(/[^\d+]/g, '');
        const normalized = raw.startsWith('+') ? raw : `+${raw}`;
        return normalized.startsWith('+966');
    }

    // ── [إعادة بناء الحملة الخاصة] توسيع كل مجموعة مُختارة إلى أعضائها ─────────
    // المؤهَّلين فقط (سعودي + ليس مشرفاً) واستبدال صف "المجموعة" الواحد بصفٍّ
    // مستقل لكل عضو مؤهَّل — بحيث يصبح كل صف في private_campaign_groups يمثّل
    // "رسالة خاصة إلى عضو" وليس "رسالة إلى المجموعة نفسها". هذا التوسيع يتم
    // مرة واحدة فقط لكل مجموعة (تُعلَّم الصفوف الأصلية بـ status='expanded'
    // بعد استبدالها كي لا تُعاد معالجتها إن أُعيد تشغيل الحملة).
    async _expandGroupsToMembers(campaignId, messagesPerAccount) {
        const pendingGroups = await pool.query(
            `SELECT * FROM private_campaign_groups
             WHERE campaign_id=$1 AND status='pending'
             ORDER BY created_at ASC`,
            [campaignId]
        );

        if (pendingGroups.rows.length === 0) return;

        // عدد الرسائل الخاصة المُرسَلة/المُجدوَلة فعلياً لكل حساب حتى الآن —
        // يُستخدم لتطبيق حد "عدد الرسائل لكل حساب" على الأعضاء (وليس على
        // عدد المجموعات كما كان سابقاً)، لأن هذا هو المعنى الحقيقي لهذا
        // الحقل كما يظهر للمستخدم في الواجهة ("عدد الرسائل لكل حساب").
        const already = await pool.query(
            `SELECT account_id, COUNT(*)::int AS cnt
             FROM private_campaign_groups
             WHERE campaign_id=$1 AND status IN ('pending','sent','failed')
             GROUP BY account_id`,
            [campaignId]
        );
        const perAccountCount = {};
        already.rows.forEach(r => { perAccountCount[r.account_id] = r.cnt; });

        for (const grp of pendingGroups.rows) {
            const accountId = grp.account_id;
            const rawJid = String(grp.group_jid || '');
            const isValidGroupIdentifier = /^[0-9]{5,}(-[0-9]+)?(@g\.us)?$/.test(rawJid);

            if (!isValidGroupIdentifier) {
                await pool.query(
                    `UPDATE private_campaign_groups SET status='failed', error_msg=$2 WHERE id=$1`,
                    [grp.id, `معرّف المجموعة غير صالح (group_jid="${rawJid}")`]
                );
                await this._log(campaignId, 'error',
                    `❌ تعذّر توسيع المجموعة ${grp.group_name || rawJid}: معرّف غير صالح`,
                    accountId
                );
                continue;
            }

            const groupJid = rawJid.includes('@') ? rawJid : `${rawJid}@g.us`;

            try {
                const membersInfo = await WhatsAppManager.getGroupMembers(accountId, groupJid);

                // 1) استثناء جميع المشرفين/السوبر أدمن — target_jids لا يحتوي
                //    عليهم أصلاً، لكن نُبقي الفحص صريحاً لضمان الالتزام حتى لو
                //    تغيّر مصدر البيانات مستقبلاً.
                const adminSet = new Set(membersInfo.admins || []);
                const nonAdminMembers = (membersInfo.target_jids || [])
                    .filter(memberJid => !adminSet.has(memberJid));
                const excludedAdminsCount = adminSet.size;

                // 2) الإبقاء فقط على الأرقام السعودية (+966) — الفحص على رقم
                //    الهاتف الحقيقي (phone_by_jid) وليس على الـ jid مباشرة،
                //    لأن الأخير قد يكون معرّف LID داخلي عشوائي عند تفعيل
                //    خصوصية الرقم في واتساب.
                const phoneByJid    = membersInfo.phone_by_jid    || {};
                const sendableByJid = membersInfo.sendable_by_jid || {};
                const saudiMembers = nonAdminMembers.filter(memberJid => {
                    const realPhone = phoneByJid[memberJid] || memberJid;
                    return this._isSaudiNumber(realPhone);
                });
                const excludedNonSaudiCount = nonAdminMembers.length - saudiMembers.length;

                // 3) الإبقاء فقط على الأعضاء الذين تأكَّد فعلياً أن لديهم jid
                //    قابلاً لاستقبال رسالة خاصة حقيقية (sendable_by_jid) — من
                //    دون ذلك لا يوجد ضمان وصول الرسالة كمحادثة خاصة فعلية.
                const eligible = saudiMembers
                    .map(memberJid => ({ memberJid, sendJid: sendableByJid[memberJid] }))
                    .filter(e => !!e.sendJid);
                const excludedUnresolvedCount = saudiMembers.length - eligible.length;

                await this._log(campaignId, 'info',
                    `👥 ${grp.group_name || groupJid} — مؤهّلون: ${eligible.length} | ` +
                    `مشرفون مستثناة: ${excludedAdminsCount} | ` +
                    `أرقام غير سعودية مستبعدة: ${excludedNonSaudiCount}` +
                    (excludedUnresolvedCount > 0 ? ` | تعذّر تأكيد رقمهم: ${excludedUnresolvedCount}` : ''),
                    accountId
                );

                // تطبيق حد "رسائل/حساب" على الأعضاء المؤهَّلين لهذا الحساب
                const currentCount = perAccountCount[accountId] || 0;
                const remainingSlots = Math.max(0, messagesPerAccount - currentCount);
                const toInsert = eligible.slice(0, remainingSlots);
                const skippedByLimit = eligible.length - toInsert.length;

                const client = await pool.connect();
                try {
                    await client.query('BEGIN');
                    for (const { sendJid } of toInsert) {
                        await client.query(
                            `INSERT INTO private_campaign_groups
                                (id, campaign_id, account_id, group_jid, group_name, status)
                             VALUES ($1,$2,$3,$4,$5,'pending')`,
                            [crypto.randomUUID(), campaignId, accountId, sendJid,
                             grp.group_name ? `عضو من: ${grp.group_name}` : null]
                        );
                    }
                    // الصف الأصلي (كان يمثّل "المجموعة") تم استبداله بصفوف
                    // الأعضاء أعلاه؛ نُعلّمه expanded كي لا يُعاد توسيعه أو
                    // إرساله كرسالة إلى المجموعة نفسها.
                    await client.query(
                        `UPDATE private_campaign_groups SET status='expanded' WHERE id=$1`,
                        [grp.id]
                    );
                    await client.query('COMMIT');
                } catch (txErr) {
                    await client.query('ROLLBACK');
                    throw txErr;
                } finally {
                    client.release();
                }

                perAccountCount[accountId] = currentCount + toInsert.length;

                if (skippedByLimit > 0) {
                    await this._log(campaignId, 'warning',
                        `⚠️ تم تجاوز ${skippedByLimit} عضو مؤهَّل من ${grp.group_name || groupJid} بسبب حد "رسائل/حساب"`,
                        accountId
                    );
                }

                // تحديث total_targets ليعكس العدد الحقيقي للأعضاء المؤهَّلين
                await pool.query(
                    `UPDATE private_campaigns SET
                        total_targets = (SELECT COUNT(*) FROM private_campaign_groups WHERE campaign_id=$1 AND status IN ('pending','sent','failed')),
                        updated_at = NOW()
                     WHERE id=$1`,
                    [campaignId]
                );
            } catch (err) {
                await pool.query(
                    `UPDATE private_campaign_groups SET status='failed', error_msg=$2 WHERE id=$1`,
                    [grp.id, err.message]
                );
                await this._log(campaignId, 'error',
                    `❌ تعذّر جلب أعضاء ${grp.group_name || rawJid}: ${err.message}`,
                    accountId
                );
            }
        }
    }

    // ── Execution Engine ───────────────────────────────────────────────────────
    // [إعادة بناء الحملة الخاصة] الحملة "الخاصة" يجب ألا تُرسل أي رسالة إلى
    // المجموعة نفسها بتاتاً. بدلاً من ذلك: لكل مجموعة مُختارة، نجلب أعضاءها
    // عبر WhatsAppManager.getGroupMembers، نستثني كل المشرفين، ونُبقي فقط على
    // الأرقام السعودية (+966)، ثم نُرسل رسالة خاصة (DM) لكل عضو مؤهَّل — أبداً
    // إلى المجموعة. هذا يستبدل الاستدعاء القديم لـ sendGroupMessage بالكامل.
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

        // [إعادة بناء الحملة الخاصة] توسيع المجموعات المختارة إلى أعضائها
        // المؤهَّلين (سعودي + غير مشرف) قبل أي إرسال. يجب أن يتم هذا قبل بدء
        // حلقة الإرسال كي تعكس total_targets/العدادات العدد الحقيقي للأهداف.
        try {
            const campRes = await pool.query(
                `SELECT messages_per_account FROM private_campaigns WHERE id=$1`,
                [campaignId]
            );
            const messagesPerAccount = campRes.rows[0]?.messages_per_account || 50;
            await this._expandGroupsToMembers(campaignId, messagesPerAccount);
        } catch (expandErr) {
            await this._log(campaignId, 'error', `❌ فشل توسيع المجموعات إلى أعضاء: ${expandErr.message}`);
        }

        // Main loop: fetch pending member-targets one at a time (each row is
        // now a single qualifying member — never the group itself)
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

            // Try to send — الهدف هنا دائماً عضو مؤهَّل (رسالة خاصة)، أبداً
            // المجموعة نفسها — لا يوجد أي مسار هنا يستدعي sendGroupMessage.
            try {
                const rawJid = String(target.group_jid || '');
                const isValidMemberJid = /^[0-9]{5,}@s\.whatsapp\.net$/.test(rawJid);
                if (!isValidMemberJid) {
                    throw new Error(
                        `معرّف العضو غير صالح للإرسال الخاص (jid="${rawJid}")`
                    );
                }

                // [البند 5+6] إرسال خاص حصراً عبر sendMessageSafe مع
                // operationType='private' صراحةً.
                await WhatsAppManager.sendMessageSafe(target.account_id, rawJid, { text: messageText }, {
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
                    `✅ أُرسلت خاص إلى: ${rawJid.split('@')[0]} (عبر ${target.account_id})`,
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
                    `❌ فشل الإرسال الخاص إلى ${String(target.group_jid || '').split('@')[0]}: ${err.message}`,
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

