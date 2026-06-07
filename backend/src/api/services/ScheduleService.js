const DatabaseManager = require('../../database/DatabaseManager');
const crypto = require('crypto');
const JobScheduler = require('../../scheduler/JobScheduler');

class ScheduleService {
    async createSchedule(accountId, { name, content, targetJid, scheduledAt, repeatType, repeatInterval, repeatCount, priority, timezone }) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const id = crypto.randomUUID();

        await accountDB.run(
            `INSERT INTO scheduled_messages (id, name, content, target_jid, scheduled_at, repeat_type, repeat_interval, repeat_count, priority, timezone)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [id, name, content, targetJid, scheduledAt || new Date().toISOString(), repeatType || 'none', repeatInterval || 0, repeatCount || 0, priority || 5, timezone || 'Asia/Riyadh']
        );

        await this.logEvent(accountDB, id, 'info', 'Scheduled message created.');

        // If immediate or scheduled, queue the task
        if (scheduledAt) {
            await JobScheduler.scheduleTask(
                accountId,
                'send_scheduled_message',
                { scheduleId: id, to: targetJid, content: content },
                new Date(scheduledAt),
                priority || 5
            );
        }

        return id;
    }

    async startSchedule(accountId, scheduleId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const schedule = await accountDB.get(`SELECT * FROM scheduled_messages WHERE id = $1`, [scheduleId]);
        if (!schedule) throw new Error('Schedule not found');

        await accountDB.run(`UPDATE scheduled_messages SET status = 'active', updated_at = NOW() WHERE id = $1`, [scheduleId]);

        await JobScheduler.scheduleTask(
            accountId,
            'send_scheduled_message',
            { scheduleId: scheduleId, to: schedule.target_jid, content: schedule.content },
            new Date(schedule.scheduled_at || Date.now()),
            schedule.priority
        );

        await this.logEvent(accountDB, scheduleId, 'info', 'Schedule activated and queued.');
        return { success: true };
    }

    async pauseSchedule(accountId, scheduleId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        await accountDB.run(`UPDATE scheduled_messages SET status = 'paused', updated_at = NOW() WHERE id = $1`, [scheduleId]);
        
        // Remove pending tasks
        await accountDB.run(
            `DELETE FROM scheduled_tasks WHERE status = 'pending' AND type = 'send_scheduled_message' AND payload LIKE $1`,
            [`%"scheduleId":"${scheduleId}"%`]
        );

        await this.logEvent(accountDB, scheduleId, 'info', 'Schedule paused.');
        return { success: true };
    }

    async deleteSchedule(accountId, scheduleId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        await accountDB.run(`DELETE FROM schedule_logs WHERE schedule_id = $1`, [scheduleId]);
        await accountDB.run(`DELETE FROM scheduled_messages WHERE id = $1`, [scheduleId]);
        return { success: true };
    }

    async getAll(accountId) {
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        return await accountDB.all(`SELECT * FROM scheduled_messages ORDER BY scheduled_at DESC`);
    }

    async logEvent(accountDB, scheduleId, level, message) {
        await accountDB.run(
            `INSERT INTO schedule_logs (id, schedule_id, level, message) VALUES ($1, $2, $3, $4)`,
            [crypto.randomUUID(), scheduleId, level, message]
        );
    }
}

module.exports = new ScheduleService();
