const ScheduleService = require('../services/ScheduleService');

class ScheduleController {
    async createSchedule(req, res) {
        try {
            const { accountId } = req.params;
            const { name, content, targetJid, scheduledAt, repeatType, repeatInterval, repeatCount, priority, timezone } = req.body;

            if (!name || !content || !targetJid) {
                return res.status(400).json({ success: false, error: 'name, content, and targetJid are required.' });
            }

            const scheduleId = await ScheduleService.createSchedule(accountId, { name, content, targetJid, scheduledAt, repeatType, repeatInterval, repeatCount, priority, timezone });
            res.status(201).json({ success: true, scheduleId });
        } catch (error) {
            console.error('Create Schedule Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async startSchedule(req, res) {
        try {
            const { accountId, scheduleId } = req.params;
            const result = await ScheduleService.startSchedule(accountId, scheduleId);
            res.json(result);
        } catch (error) {
            console.error('Start Schedule Error:', error);
            res.status(500).json({ success: false, error: error.message });
        }
    }

    async pauseSchedule(req, res) {
        try {
            const { accountId, scheduleId } = req.params;
            const result = await ScheduleService.pauseSchedule(accountId, scheduleId);
            res.json(result);
        } catch (error) {
            console.error('Pause Schedule Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async deleteSchedule(req, res) {
        try {
            const { accountId, scheduleId } = req.params;
            const result = await ScheduleService.deleteSchedule(accountId, scheduleId);
            res.json(result);
        } catch (error) {
            console.error('Delete Schedule Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getAll(req, res) {
        try {
            const { accountId } = req.params;
            const schedules = await ScheduleService.getAll(accountId);
            res.json({ success: true, schedules });
        } catch (error) {
            console.error('Get Schedules Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new ScheduleController();
