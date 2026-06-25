const DatabaseManager = require('../../database/DatabaseManager');
const pool = require('../../lib/postgres');

class ScheduleMonitorController {

    /**
     * GET /accounts/:accountId/broadcast/monitor
     * يرجع بيانات المتابعة للنشر المجدول لحساب واحد:
     *  - الجداول النشطة مع أقرب موعد نشر
     *  - إحصائيات المجموعات (إجمالي / تم النشر / متبقي)
     *  - إحصائيات النشر الخاص من private_campaigns
     */
    async getMonitor(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            // ── 1. الجداول النشطة ─────────────────────────────────────────────
            const schedules = await accountDB.all(
                `SELECT id, name, status,
                        COALESCE(target_group_jids, '[]') as target_group_jids,
                        COALESCE(ad_library_ids, '[]')    as ad_library_ids,
                        COALESCE(active_days, '[0,1,2,3,4,5,6]') as active_days,
                        COALESCE(publish_times, '[]')     as publish_times,
                        COALESCE(max_per_day, 3)          as max_per_day,
                        send_to_members,
                        created_at, updated_at
                 FROM broadcast_schedules
                 WHERE (account_id = $1 OR account_id IS NULL)
                 ORDER BY created_at DESC`,
                [accountId]
            );

            const parsed = schedules.map(s => ({
                ...s,
                target_group_jids: this._parse(s.target_group_jids, []),
                ad_library_ids:    this._parse(s.ad_library_ids, []),
                active_days:       this._parse(s.active_days, [0,1,2,3,4,5,6]),
                publish_times:     this._parse(s.publish_times, []),
            }));

            // ── 2. أقرب موعد نشر (للعداد العام) ─────────────────────────────
            const now        = new Date();
            let nextPublish  = null;           // { isoString, scheduleId, scheduleName }

            for (const sch of parsed) {
                if (sch.status !== 'active') continue;
                const candidate = this._nextPublishTime(sch.active_days, sch.publish_times, now);
                if (candidate && (!nextPublish || candidate < new Date(nextPublish.isoString))) {
                    nextPublish = {
                        isoString:    candidate.toISOString(),
                        scheduleId:   sch.id,
                        scheduleName: sch.name,
                    };
                }
            }

            // ── 3. إحصائيات المجموعات لكل جدول نشط ──────────────────────────
            //    نحسب: إجمالي المجموعات، تم النشر اليوم (من direct_publish_log)، متبقي
            const todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);

            // اجمع كل المجموعات الكلية والمُرسل إليها اليوم لهذا الحساب
            let totalGroupCount    = 0;
            let publishedToday     = 0;
            let activeScheduleCount = 0;

            for (const sch of parsed) {
                if (sch.status !== 'active') continue;
                activeScheduleCount++;
                totalGroupCount += sch.target_group_jids.length;
            }

            // من سجل النشر المباشر: كم مجموعة تم إرسالها اليوم
            try {
                const logRows = await accountDB.all(
                    `SELECT target_group_jids FROM direct_publish_log
                     WHERE account_id = $1 AND sent_at >= $2`,
                    [accountId, todayStart.toISOString()]
                );
                const sentJids = new Set();
                for (const row of logRows) {
                    const jids = this._parse(row.target_group_jids, []);
                    jids.forEach(j => sentJids.add(j));
                }
                publishedToday = sentJids.size;
            } catch (_) { /* جدول قد لا يكون موجوداً في بيئة الاختبار */ }

            // ── 4. النشر الخاص (private_campaigns) لهذا الحساب ──────────────
            let privateCampaignStats = null;
            try {
                const userId = req.user?.id;
                if (userId) {
                    const pcRes = await pool.query(
                        `SELECT pc.id, pc.name, pc.status,
                                pc.total_targets, pc.sent_count, pc.failed_count,
                                pc.interval_seconds, pc.start_time, pc.end_time,
                                pc.updated_at,
                                pca.messages_sent, pca.messages_limit, pca.messages_failed
                         FROM private_campaigns pc
                         LEFT JOIN private_campaign_accounts pca
                           ON pca.campaign_id = pc.id AND pca.account_id = $2
                         WHERE pc.user_id = $1
                           AND pc.status IN ('running','paused','draft')
                         ORDER BY pc.created_at DESC
                         LIMIT 5`,
                        [userId, accountId]
                    );
                    privateCampaignStats = pcRes.rows;
                }
            } catch (_) { /* لا يوجد جدول private_campaigns بعد */ }

            res.json({
                success: true,
                accountId,
                schedules: parsed,
                summary: {
                    totalSchedules:      parsed.length,
                    activeSchedules:     activeScheduleCount,
                    pausedSchedules:     parsed.length - activeScheduleCount,
                    totalGroupCount,
                    publishedToday,
                    remainingGroups:     Math.max(0, totalGroupCount - publishedToday),
                },
                nextPublish,
                privateCampaigns: privateCampaignStats || [],
            });
        } catch (err) {
            console.error('[ScheduleMonitor] getMonitor error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    /**
     * POST /accounts/:accountId/broadcast/publish-now
     * نشر مباشر لجدول معين الآن
     */
    async publishNow(req, res) {
        try {
            const { accountId } = req.params;
            const { scheduleId } = req.body;

            if (!scheduleId) {
                return res.status(400).json({ success: false, error: 'scheduleId مطلوب' });
            }

            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const schedule = await accountDB.get(
                `SELECT * FROM broadcast_schedules WHERE id = $1`,
                [scheduleId]
            );

            if (!schedule) {
                return res.status(404).json({ success: false, error: 'الجدول غير موجود' });
            }

            // تشغيل الجدول (سيتولى JobScheduler أو BroadcastController التنفيذ الفعلي)
            await accountDB.run(
                `UPDATE broadcast_schedules SET status = 'active', updated_at = NOW() WHERE id = $1`,
                [scheduleId]
            );

            res.json({ success: true, message: 'تم إطلاق النشر المباشر' });
        } catch (err) {
            console.error('[ScheduleMonitor] publishNow error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    _parse(val, fallback) {
        if (Array.isArray(val)) return val;
        try { return JSON.parse(val || JSON.stringify(fallback)); } catch (_) { return fallback; }
    }

    /**
     * يحسب أقرب وقت نشر قادم بناءً على active_days و publish_times
     * @param {number[]} activeDays  - 0=الأحد .. 6=السبت
     * @param {string[]} times       - ["09:00","18:00"]
     * @param {Date}     from        - من هذه اللحظة
     * @returns {Date|null}
     */
    _nextPublishTime(activeDays, times, from) {
        if (!times || times.length === 0) return null;
        const days = activeDays && activeDays.length > 0 ? activeDays : [0,1,2,3,4,5,6];

        let best = null;

        for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
            const candidate = new Date(from);
            candidate.setDate(candidate.getDate() + dayOffset);
            const weekday = candidate.getDay();

            if (!days.includes(weekday)) continue;

            for (const t of times) {
                const [hh, mm] = t.split(':').map(Number);
                const dt = new Date(candidate);
                dt.setHours(hh, mm, 0, 0);
                if (dt > from) {
                    if (!best || dt < best) best = dt;
                }
            }

            if (best) break; // أول يوم يحتوي وقتاً مستقبلياً يكفي
        }

        return best;
    }
}

module.exports = new ScheduleMonitorController();
