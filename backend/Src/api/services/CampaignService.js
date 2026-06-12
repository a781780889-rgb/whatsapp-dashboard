const DatabaseManager = require('../../database/DatabaseManager');
const crypto = require('crypto');
const JobScheduler = require('../../scheduler/JobScheduler');
const WhatsAppManager = require('../../bot/WhatsAppManager');

class CampaignService {
    async preflightCheck(accountId, { targetType, targetIds, excludeAdmins, excludeDuplicates }) {
        let totalRaw = 0;
        let finalTargets = new Set();
        let excluded = {
            admin: 0,
            duplicate: 0,
            invalid: 0
        };

        if (targetType === 'group_members') {
            for (const groupId of targetIds) {
                try {
                    const membersInfo = await WhatsAppManager.getGroupMembers(accountId, groupId);
                    totalRaw += membersInfo.total;

                    membersInfo.target_jids.forEach(jid => {
                        if (finalTargets.has(jid) && excludeDuplicates) {
                            excluded.duplicate++;
                        } else {
                            finalTargets.add(jid);
                        }
                    });

                    if (excludeAdmins) {
                        membersInfo.admins.forEach(jid => {
                            excluded.admin++;
                            // We don't add to finalTargets
                        });
                    } else {
                        membersInfo.admins.forEach(jid => {
                            if (finalTargets.has(jid) && excludeDuplicates) {
                                excluded.duplicate++;
                            } else {
                                finalTargets.add(jid);
                            }
                        });
                    }
                } catch (e) {
                    console.error('Preflight: Failed to get group', groupId, e);
                    excluded.invalid++;
                }
            }
        } else if (targetType === 'lists') {
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            for (const listId of targetIds) {
                const contacts = await accountDB.all(`SELECT * FROM contacts WHERE list_id = $1`, [listId]);
                totalRaw += contacts.length;
                contacts.forEach(c => {
                    if (!c.is_active || c.opted_out) {
                        excluded.invalid++;
                        return;
                    }
                    if (excludeAdmins && c.is_admin) {
                        excluded.admin++;
                        return;
                    }
                    if (finalTargets.has(c.jid) && excludeDuplicates) {
                        excluded.duplicate++;
                    } else {
                        finalTargets.add(c.jid);
                    }
                });
            }
        }

        return {
            totalRaw,
            totalFinal: finalTargets.size,
            excludedCount: totalRaw - finalTargets.size,
            excludedDetails: excluded,
            finalJids: Array.from(finalTargets)
        };
    }

    async createCampaign(accountId, { name, adLibraryId, targetType, targetIds, batchSize, intervalSeconds, dailyLimit, scheduledAt, excludeAdmins, excludeDuplicates }) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const campaignId = crypto.randomUUID();

        // 1. Preflight to get final jids
        const preflight = await this.preflightCheck(accountId, { targetType, targetIds, excludeAdmins, excludeDuplicates });

        // 2. Insert Campaign
        await accountDB.run(
            `INSERT INTO campaigns (id, name, ad_library_id, status, target_type, batch_size, interval_seconds, daily_limit, scheduled_at) 
             VALUES ($2, $3, $4, 'draft', $1, $2, $3, $4, $5)`,
            [campaignId, name, adLibraryId, targetType, batchSize || 50, intervalSeconds || 10, dailyLimit || 1000, scheduledAt || new Date().toISOString()]
        );

        // 3. Insert Campaign Targets in batches
        const insertStmt = `INSERT INTO campaign_targets (id, campaign_id, target_jid) VALUES ($6, $7, $8)`;
        for (const jid of preflight.finalJids) {
            await accountDB.run(insertStmt, [crypto.randomUUID(), campaignId, jid]);
        }

        // 4. Record exclusions if needed (simplified for now)
        await this.logEvent(accountDB, campaignId, 'info', `Campaign created. Raw targets: ${preflight.totalRaw}, Excluded: ${preflight.excludedCount}, Final: ${preflight.totalFinal}.`);
        
        return campaignId;
    }

    async startCampaign(accountId, campaignId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        
        // 1. Fetch Campaign Info
        const campaign = await accountDB.get(`SELECT * FROM campaigns WHERE id = $1`, [campaignId]);
        if (!campaign) throw new Error('Campaign not found');

        // 2. Update status
        await accountDB.run(`UPDATE campaigns SET status = 'running', updated_at = NOW() WHERE id = $1`, [campaignId]);

        // 3. Fetch targets
        const targets = await accountDB.all(`SELECT * FROM campaign_targets WHERE campaign_id = $2 AND status = 'pending'`, [campaignId]);
        
        // 4. Fetch Ad Content
        const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [campaign.ad_library_id]);
        
        // 5. Queue into JobScheduler
        let delayCounter = 0;
        for (const target of targets) {
            // Apply interval delay
            const executeAt = new Date(Date.now() + (delayCounter * (campaign.interval_seconds * 1000)));
            
            await JobScheduler.scheduleTask(
                accountId, 
                'send_campaign_message', 
                { 
                    campaignId: campaignId, 
                    targetId: target.id, 
                    to: target.target_jid, 
                    adId: ad ? ad.id : null,
                    fallbackContent: ad ? ad.text_content : 'No Ad Content Found'
                },
                executeAt,
                10 // priority
            );
            delayCounter++;
        }

        await this.logEvent(accountDB, campaignId, 'info', `Campaign started. Queued ${targets.length} messages with ${campaign.interval_seconds}s interval.`);
        return { success: true, queued: targets.length };
    }

    async pauseCampaign(accountId, campaignId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        
        await accountDB.run(`UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1`, [campaignId]);

        // Section 9.3 (BullMQ): BullMQ worker checks campaign status before sending.
        // Paused campaigns are automatically skipped by the worker. No need to delete queue entries.
        await this.logEvent(accountDB, campaignId, 'info', `Campaign paused. BullMQ worker will skip remaining pending jobs.`);
        return { success: true };
    }

    async getStats(accountId, campaignId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        
        const total = await accountDB.get(`SELECT COUNT(*) as count FROM campaign_targets WHERE campaign_id = $1`, [campaignId]);
        const sent = await accountDB.get(`SELECT COUNT(*) as count FROM campaign_targets WHERE campaign_id = $1 AND status = 'sent'`, [campaignId]);
        const failed = await accountDB.get(`SELECT COUNT(*) as count FROM campaign_targets WHERE campaign_id = $1 AND status = 'failed'`, [campaignId]);
        const logs = await accountDB.all(`SELECT * FROM campaign_logs WHERE campaign_id = $1 ORDER BY created_at DESC LIMIT 50`, [campaignId]);
        const exclusions = await accountDB.all(`SELECT reason, COUNT(*) as count FROM campaign_exclusions WHERE campaign_id = $1 GROUP BY reason`, [campaignId]);

        return {
            total: parseInt(total?.count || 0, 10),
            sent: parseInt(sent?.count || 0, 10),
            failed: parseInt(failed?.count || 0, 10),
            pending: parseInt(total.count || 0, 10) - parseInt(sent.count || 0, 10) - failed.count,
            logs,
            exclusions
        };
    }

    async logEvent(accountDB, campaignId, level, message) {
        const logId = crypto.randomUUID();
        await accountDB.run(
            `INSERT INTO campaign_logs (id, campaign_id, level, message) VALUES ($1, $2, $3, $4)`,
            [logId, campaignId, level, message]
        );
    }
}

module.exports = new CampaignService();
