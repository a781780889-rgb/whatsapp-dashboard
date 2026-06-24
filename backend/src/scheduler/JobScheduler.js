'use strict';
/**
 * JobScheduler — BullMQ Edition
 *
 * إصلاح: كل Queue/Worker يحصل على اتصال Redis مستقل عبر getBullMQConnection()
 * (maxRetriesPerRequest: null + enableReadyCheck: false — متطلب BullMQ v5)
 */
const { Queue, Worker } = require('bullmq');
const crypto = require('crypto');
const { getBullMQConnection } = require('../lib/redis');
const DatabaseManager = require('../database/DatabaseManager');

const QUEUE_NAME = 'wa-tasks';

class JobScheduler {
    constructor() {
        this.queue     = null;
        this.worker    = null;
        this.isRunning = false;
    }

    // ── Start ─────────────────────────────────────────────────────────────────
    async start() {
        if (this.isRunning) return;
        this.isRunning = true;

        // كل instance يحتاج اتصال Redis مستقل — هذا متطلب BullMQ
        this.queue = new Queue(QUEUE_NAME, {
            connection: getBullMQConnection(),
            defaultJobOptions: {
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
                removeOnComplete: { count: 100, age: 86400 },
                removeOnFail:     { count: 500, age: 604800 },
            }
        });

        this.worker = new Worker(QUEUE_NAME, async (job) => {
            await this._executeTask(job);
        }, {
            connection:  getBullMQConnection(),   // اتصال مستقل للـ Worker
            concurrency: parseInt(process.env.BULLMQ_CONCURRENCY || '5', 10),
            limiter:     { max: 10, duration: 1000 },
        });

        this.worker.on('completed', (job) => {
            console.log(`[BullMQ] Job ${job.id} (${job.name}) completed for account ${job.data.accountId}`);
        });
        this.worker.on('failed', (job, err) => {
            console.error(`[BullMQ] Job ${job?.id} (${job?.name}) failed:`, err.message);
        });
        this.worker.on('error', (err) => {
            console.error('[BullMQ] Worker error:', err.message);
        });

        await this._runSelfHealing();
        this._startSubscriptionExpiryScheduler();
        this._startDailyCounterScheduler();
        console.log('[BullMQ] JobScheduler started. Queue:', QUEUE_NAME);
    }

    // ── Stop — Graceful Shutdown ───────────────────────────────────────────────
    async stop() {
        if (!this.isRunning) return;
        this.isRunning = false;
        if (this._subscriptionExpiryTimer) clearInterval(this._subscriptionExpiryTimer);
        if (this._dailyTimer)              clearInterval(this._dailyTimer);
        if (this.worker) {
            await this.worker.close();
            console.log('[BullMQ] Worker stopped gracefully.');
        }
        if (this.queue) {
            await this.queue.close();
        }
    }

    // ── Self-Healing ──────────────────────────────────────────────────────────
    async _runSelfHealing() {
        try {
            if (!this.queue) return;
            const waiting = await this.queue.getWaiting(0, 10);
            console.log(`[BullMQ] Self-healing: ${waiting.length} jobs waiting in queue.`);
        } catch (err) {
            console.error('[BullMQ] Self-healing error:', err.message);
        }
    }

    // ── Public API: Schedule a Task ───────────────────────────────────────────
    async scheduleTask(accountId, type, payload, executeAt = new Date(), priority = 0) {
        if (!this.queue) throw new Error('[BullMQ] Queue not initialized. Call start() first.');

        const delay       = Math.max(0, new Date(executeAt).getTime() - Date.now());
        const bullPriority = Math.max(1, 20 - priority);
        const jobId       = crypto.randomUUID();

        await this.queue.add(type, {
            accountId,
            taskId: jobId,
            ...payload,
        }, {
            jobId,
            delay,
            priority: bullPriority,
        });

        console.log(`[BullMQ] Scheduled job ${jobId} type=${type} account=${accountId} delay=${delay}ms`);
        return jobId;
    }

    // ── Execute Task ──────────────────────────────────────────────────────────
    async _executeTask(job) {
        const { accountId } = job.data;
        const WhatsAppManager = require('../bot/WhatsAppManager');
        const session = WhatsAppManager.getSession(accountId);
        if (!session) throw new Error(`WhatsApp session not active for account ${accountId}`);

        const accountDB = await DatabaseManager.getAccountDB(accountId);

        switch (job.name) {
            case 'send_campaign_message':
                await this._sendCampaignMessage(job.data, session, accountDB, accountId, WhatsAppManager);
                break;
            case 'send_scheduled_message':
                await this._sendScheduledMessage(job.data, session, accountDB, accountId, WhatsAppManager);
                break;
            case 'send_broadcast_message':
                await this._sendBroadcastMessage(job.data, session, accountDB, accountId, WhatsAppManager);
                break;
            case 'join_group':
                await this._joinGroup(job.data, session, accountDB, accountId);
                break;
            default:
                throw new Error(`Unknown task type: ${job.name}`);
        }
    }

    async _sendCampaignMessage(data, session, accountDB, accountId, WhatsAppManager) {
        const { campaignId, targetId, to } = data;
        const campaign = await accountDB.get(
            `SELECT status, ad_library_id FROM campaigns WHERE id = $1`, [campaignId]
        );
        if (!campaign || campaign.status === 'paused' || campaign.status === 'completed') {
            console.log(`[BullMQ] Skipping job: campaign ${campaignId} is ${campaign?.status || 'not found'}`);
            return;
        }
        const ad = campaign.ad_library_id
            ? await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [campaign.ad_library_id])
            : null;
        const content = ad?.content || data.fallbackContent || 'رسالة الحملة';
        try {
            await WhatsAppManager.sendMessageSafe(accountId, to, { text: content });
            await accountDB.run(
                `UPDATE campaign_targets SET status = 'sent', sent_at = NOW() WHERE id = $1`, [targetId]
            );
            await accountDB.run(
                `INSERT INTO campaign_logs (id, campaign_id, level, message) VALUES ($1, $2, 'info', $3)`,
                [crypto.randomUUID(), campaignId, `Message sent to ${to}`]
            );
        } catch (err) {
            await accountDB.run(
                `UPDATE campaign_targets SET status = 'failed', error_msg = $1 WHERE id = $2`,
                [err.message, targetId]
            );
            await accountDB.run(
                `INSERT INTO campaign_logs (id, campaign_id, level, message) VALUES ($1, $2, 'error', $3)`,
                [crypto.randomUUID(), campaignId, `Failed to send to ${to}: ${err.message}`]
            );
            throw err;
        }
    }

    async _sendScheduledMessage(data, session, accountDB, accountId, WhatsAppManager) {
        const { scheduleId, to } = data;
        const schedule = await accountDB.get(`SELECT * FROM scheduled_messages WHERE id = $1`, [scheduleId]);
        if (!schedule) throw new Error(`Scheduled message ${scheduleId} not found`);
        try {
            await WhatsAppManager.sendMessageSafe(accountId, to, { text: schedule.content });
            await accountDB.run(
                `UPDATE scheduled_messages
                 SET status = 'completed', executions_done = executions_done + 1, last_executed_at = NOW()
                 WHERE id = $1`, [scheduleId]
            );
            await accountDB.run(
                `INSERT INTO schedule_logs (id, schedule_id, level, message) VALUES ($1, $2, 'info', $3)`,
                [crypto.randomUUID(), scheduleId, `Message sent to ${to}`]
            );
        } catch (err) {
            await accountDB.run(
                `UPDATE scheduled_messages SET status = 'failed' WHERE id = $1`, [scheduleId]
            );
            await accountDB.run(
                `INSERT INTO schedule_logs (id, schedule_id, level, message) VALUES ($1, $2, 'error', $3)`,
                [crypto.randomUUID(), scheduleId, `Failed: ${err.message}`]
            );
            throw err;
        }
    }

    async _joinGroup(data, session, accountDB, accountId) {
        const { url, queueId, linkId } = data;
        const inviteCodeMatch = url.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
        if (!inviteCodeMatch) throw new Error('Invalid WhatsApp group link format');
        const inviteCode = inviteCodeMatch[1];
        try {
            await session.groupAcceptInvite(inviteCode);
            console.log(`[Account ${accountId}] Joined group via ${url}`);
            await accountDB.run(
                `UPDATE auto_join_queue SET status = 'joined', joined_at = NOW() WHERE id = $1`, [queueId]
            );
            await accountDB.run(
                `INSERT INTO link_logs (id, link_id, action, details) VALUES ($1, $2, 'joined', $3)`,
                [crypto.randomUUID(), linkId, `Joined via account ${accountId}`]
            );
        } catch (err) {
            await accountDB.run(
                `UPDATE auto_join_queue SET status = 'failed', error_msg = $1 WHERE id = $2`,
                [err.message, queueId]
            );
            await accountDB.run(
                `INSERT INTO link_logs (id, link_id, action, details) VALUES ($1, $2, 'join_failed', $3)`,
                [crypto.randomUUID(), linkId, `Failed: ${err.message}`]
            );
            throw err;
        }
    }

    // ── Send Broadcast Message (Group + Optional Private Members) ────────────
    async _sendBroadcastMessage(data, session, accountDB, accountId, WhatsAppManager) {
        const { scheduleId, groupJid, adId, send_to_members, exclude_admins } = data;
        const fs   = require('fs');
        const path = require('path');
        const MEDIA_BASE = path.resolve(__dirname, '../../../');

        const schedule = await accountDB.get(
            `SELECT status FROM broadcast_schedules WHERE id = $1`, [scheduleId]
        );
        if (!schedule || schedule.status === 'paused') {
            console.log(`[BroadcastJob] Skipping — schedule ${scheduleId} is paused/missing.`);
            return;
        }

        const ad = adId ? await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [adId]) : null;
        const text = ad?.content || '';
        const mediaPaths = JSON.parse(ad?.media_paths || '[]');

        const _send = async (jid) => {
            if (mediaPaths.length > 0) {
                const mediaPath = path.join(MEDIA_BASE, mediaPaths[0]);
                if (fs.existsSync(mediaPath)) {
                    const buf = fs.readFileSync(mediaPath);
                    const ext = path.extname(mediaPaths[0]).toLowerCase();
                    if (['.jpg','.jpeg','.png','.gif','.webp'].includes(ext)) {
                        return session.sendMessage(jid, { image: buf, caption: text });
                    } else if (['.mp4','.mov','.avi'].includes(ext)) {
                        return session.sendMessage(jid, { video: buf, caption: text });
                    }
                    return session.sendMessage(jid, { document: buf, caption: text, fileName: path.basename(mediaPaths[0]) });
                }
            }
            return session.sendMessage(jid, { text });
        };

        // 1️⃣ إرسال للمجموعة
        await _send(groupJid);
        console.log(`[BroadcastJob] Sent to group ${groupJid}`);

        // 2️⃣ إرسال للأعضاء خاص
        if (send_to_members) {
            try {
                const membersInfo = await WhatsAppManager.getGroupMembers(accountId, groupJid);
                const targets = exclude_admins
                    ? membersInfo.target_jids
                    : [...membersInfo.target_jids, ...membersInfo.admins];

                let sentCount = 0;
                for (const memberJid of targets) {
                    try {
                        await _send(memberJid);
                        sentCount++;
                    } catch (e) {
                        console.error(`[BroadcastJob] Failed to send private to ${memberJid}:`, e.message);
                    }
                    await new Promise(r => setTimeout(r, 1500));
                }
                console.log(`[BroadcastJob] Sent private to ${sentCount}/${targets.length} members of ${groupJid}`);
            } catch (e) {
                console.error(`[BroadcastJob] Could not fetch members for ${groupJid}:`, e.message);
            }
        }

        if (ad) {
            await accountDB.run(
                `UPDATE ad_library SET times_used = times_used + 1, last_used_at = NOW() WHERE id = $1`, [adId]
            );
        }
        await accountDB.run(
            `UPDATE broadcast_schedules SET last_run_at = NOW(), executions_done = executions_done + 1 WHERE id = $1`, [scheduleId]
        );
    }

    // ── Subscription Expiry Scheduler (runs every hour) ───────────────────────
    _startSubscriptionExpiryScheduler() {
        this._subscriptionExpiryTimer = setInterval(async () => {
            try {
                const result = await DatabaseManager.systemDB.run(`
                    UPDATE subscriptions
                    SET status = 'expired'
                    WHERE status = 'active'
                      AND expires_at < NOW()
                `);
                const count = result?.rowCount || 0;
                if (count > 0) {
                    console.log(`[Scheduler] Expired ${count} subscription(s).`);
                }
            } catch (err) {
                console.error('[Scheduler] Subscription expiry check failed:', err.message);
            }
        }, 60 * 60 * 1000); // every hour
        console.log('[Scheduler] Subscription expiry scheduler started.');
    }

    // ── Daily Message Counter Reset (runs at midnight) ────────────────────────
    _startDailyCounterScheduler() {
        const scheduleNextMidnight = () => {
            const now = new Date();
            const nextMidnight = new Date(now);
            nextMidnight.setHours(24, 0, 0, 0);
            const msToMidnight = nextMidnight.getTime() - now.getTime();

            setTimeout(async () => {
                try {
                    await DatabaseManager.systemDB.resetDailyMessageCounters();
                    console.log('[Scheduler] Daily message counters reset.');
                } catch (err) {
                    console.error('[Scheduler] Daily counter reset failed:', err.message);
                }
                // Schedule the next midnight reset
                this._dailyTimer = setInterval(async () => {
                    try {
                        await DatabaseManager.systemDB.resetDailyMessageCounters();
                        console.log('[Scheduler] Daily message counters reset.');
                    } catch (err) {
                        console.error('[Scheduler] Daily counter reset failed:', err.message);
                    }
                }, 24 * 60 * 60 * 1000);
            }, msToMidnight);
        };
        scheduleNextMidnight();
        console.log('[Scheduler] Daily counter scheduler started (runs at midnight).');
    }

    // ── Remove All BullMQ Jobs for an Account ─────────────────────────────────
    async removeAccountJobs(accountId) {
        if (!this.queue) return;
        try {
            const [waiting, delayed] = await Promise.all([
                this.queue.getWaiting(),
                this.queue.getDelayed(),
            ]);
            const toRemove = [...waiting, ...delayed].filter(j => j.data?.accountId === accountId);
            await Promise.all(toRemove.map(j => j.remove().catch(() => {})));
            console.log(`[BullMQ] Removed ${toRemove.length} jobs for account ${accountId}.`);
        } catch (err) {
            console.error('[BullMQ] removeAccountJobs error:', err.message);
        }
    }

    // ── Pause Campaign ────────────────────────────────────────────────────────
    async pauseCampaignJobs(campaignId) {
        console.log(`[BullMQ] Campaign ${campaignId} paused — pending jobs will be skipped by worker.`);
    }

    // ── Queue Stats ───────────────────────────────────────────────────────────
    async getStats() {
        if (!this.queue) return null;
        const [waiting, active, completed, failed, delayed] = await Promise.all([
            this.queue.getWaitingCount(),
            this.queue.getActiveCount(),
            this.queue.getCompletedCount(),
            this.queue.getFailedCount(),
            this.queue.getDelayedCount(),
        ]);
        return { waiting, active, completed, failed, delayed };
    }
}

module.exports = new JobScheduler();
