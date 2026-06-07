const DatabaseManager = require('../../database/DatabaseManager');
const JobScheduler = require('../../scheduler/JobScheduler');
const crypto = require('crypto');

class GroupJoinerService {

    /**
     * Start the auto join process for a specific link or multiple links
     * Load Balancing: Selects a random active account to join the group to avoid spamming from one account.
     * Delay: Adds random delay between 5 to 15 minutes for safety.
     */
    async scheduleAutoJoin(linksArray) {
        // Find active accounts available for rotation
        const activeAccountIds = Array.from(DatabaseManager.activeAccounts.keys());
        if (activeAccountIds.length === 0) {
            throw new Error("لا يوجد أي حسابات واتساب نشطة لتنفيذ عملية الانضمام.");
        }

        let addedCount = 0;
        let baseTime = new Date();

        for (const linkObj of linksArray) {
            const { linkId, url } = linkObj;

            // 1. Smart Rotation: Pick a random active account for load balancing
            const randomAccountIndex = Math.floor(Math.random() * activeAccountIds.length);
            const targetAccountId = activeAccountIds[randomAccountIndex];

            // 2. Delay Strategy: Add random 2 to 10 minutes delay sequentially
            const randomDelayMinutes = Math.floor(Math.random() * (10 - 2 + 1)) + 2;
            baseTime.setMinutes(baseTime.getMinutes() + randomDelayMinutes);

            const queueId = crypto.randomUUID();
            const accountDB = await DatabaseManager.getAccountDB(targetAccountId);

            // 3. Register in auto_join_queue
            await accountDB.run(
                `INSERT INTO auto_join_queue (id, link_id, status, target_account_id, scheduled_at) VALUES ($1, $2, 'pending', $3, $4)`,
                [queueId, linkId, targetAccountId, baseTime.toISOString()]
            );

            // 4. Schedule the background task
            await JobScheduler.scheduleTask(
                targetAccountId,
                'join_group',
                { queueId, linkId, url },
                baseTime
            );

            addedCount++;
        }

        return addedCount;
    }
}

module.exports = new GroupJoinerService();
