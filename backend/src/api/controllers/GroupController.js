const WhatsAppManager = require('../../bot/WhatsAppManager');

class GroupController {
    async getGroups(req, res) {
        try {
            const { accountId } = req.params;
            const sock = WhatsAppManager.getSession(accountId);
            
            if (!sock) {
                return res.status(400).json({ success: false, error: 'WhatsApp session not connected' });
            }

            // Fetch all groups the bot is part of
            const groupMetadata = await sock.groupFetchAllParticipating();
            const groups = Object.values(groupMetadata).map(group => ({
                id: group.id,
                name: group.subject,
                participants_count: group.participants.length
            }));

            res.json({ success: true, groups });
        } catch (error) {
            console.error('Get Groups Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getGroupMembers(req, res) {
        try {
            const { accountId, groupId } = req.params;
            const result = await WhatsAppManager.getGroupMembers(accountId, groupId);
            res.json({ success: true, ...result });
        } catch (error) {
            console.error('Get Group Members Error:', error);
            res.status(500).json({ success: false, error: 'Failed to fetch group members' });
        }
    }
}

module.exports = new GroupController();
