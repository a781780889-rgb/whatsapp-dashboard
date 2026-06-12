const CampaignService = require('../services/CampaignService');
const DatabaseManager = require('../../database/DatabaseManager');

class CampaignController {
    async preflightCheck(req, res) {
        try {
            const { accountId } = req.params;
            const { targetType, targetIds, excludeAdmins, excludeDuplicates } = req.body;

            const result = await CampaignService.preflightCheck(accountId, { targetType, targetIds, excludeAdmins, excludeDuplicates });
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('Preflight Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async createCampaign(req, res) {
        try {
            const { accountId } = req.params;
            const { name, adLibraryId, targetType, targetIds, batchSize, intervalSeconds, dailyLimit, scheduledAt, excludeAdmins, excludeDuplicates } = req.body;

            if (!name || !adLibraryId || !targetIds || !Array.isArray(targetIds) || targetIds.length === 0) {
                return res.status(400).json({ success: false, error: 'Invalid campaign data.' });
            }

            const campaignId = await CampaignService.createCampaign(accountId, {
                name, adLibraryId, targetType, targetIds, batchSize, intervalSeconds, dailyLimit, scheduledAt, excludeAdmins, excludeDuplicates
            });
            
            res.status(201).json({ success: true, message: 'Campaign created', campaignId });
        } catch (error) {
            console.error('Create Campaign Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async startCampaign(req, res) {
        try {
            const { accountId, campaignId } = req.params;
            const result = await CampaignService.startCampaign(accountId, campaignId);
            res.json(result);
        } catch (error) {
            console.error('Start Campaign Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async pauseCampaign(req, res) {
        try {
            const { accountId, campaignId } = req.params;
            const result = await CampaignService.pauseCampaign(accountId, campaignId);
            res.json(result);
        } catch (error) {
            console.error('Pause Campaign Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getStats(req, res) {
        try {
            const { accountId, campaignId } = req.params;
            const stats = await CampaignService.getStats(accountId, campaignId);
            res.json({ success: true, stats });
        } catch (error) {
            console.error('Get Stats Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async listCampaigns(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            
            const campaigns = await accountDB.all(`
                SELECT c.*, 
                       (SELECT COUNT(*) FROM campaign_targets WHERE campaign_id = c.id) as total_targets,
                       (SELECT COUNT(*) FROM campaign_targets WHERE campaign_id = c.id AND status = 'sent') as sent_count,
                       (SELECT COUNT(*) FROM campaign_targets WHERE campaign_id = c.id AND status = 'failed') as failed_count
                FROM campaigns c
                ORDER BY c.created_at DESC
            `);
            
            res.json({ success: true, campaigns });
        } catch (error) {
            console.error('List Campaigns Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new CampaignController();
