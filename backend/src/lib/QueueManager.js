'use strict';
/**
 * QueueManager — [FIX-20] Centralized Queue System
 *
 * المشكلة قبل الإصلاح:
 *   - PrivateCampaignService يستخدم setTimeout داخل loop لإرسال الرسائل:
 *       for (const member of members) {
 *           await delay(waitMs);      ← setTimeout مباشر
 *           await sendMessage(...)
 *       }
 *   - المشاكل:
 *       1. إذا مات الـ process: كل المهام المعلّقة تضيع
 *       2. لا يمكن إيقاف/استئناف حملة بعد بدء التنفيذ
 *       3. استهلاك memory متزايد مع كل حملة (عشرات الـ timers المعلّقة)
 *       4. لا يمكن مراقبة التقدم من خارج الـ process
 *
 * الحل — QueueManager مع 3 Queues مخصصة:
 *   ┌─────────────────────┬────────────────────────────────────────────────┐
 *   │ wa-campaigns        │ إرسال رسائل الحملات (Broadcast + Private)      │
 *   │ wa-sync             │ مزامنة المجموعات + تحديث البيانات               │
 *   │ wa-notifications    │ إشعارات النظام الداخلية                         │
 *   └─────────────────────┴────────────────────────────────────────────────┘
 *
 * كل Worker لديه concurrency مستقل ومعدّل إرسال محكوم
 */

const { Queue, Worker, QueueEvents } = require('bullmq');
const { getBullMQConnection }        = require('./redis');

// ── Queue Names ───────────────────────────────────────────────────────────────
const QUEUES = {
    CAMPAIGNS:     'wa-campaigns',
    SYNC:          'wa-sync',
    NOTIFICATIONS: 'wa-notifications',
};

// ── Default Job Options ───────────────────────────────────────────────────────
const DEFAULT_JOB_OPTIONS = {
    attempts: 3,
    backoff:  { type: 'exponential', delay: 3_000 },
    removeOnComplete: { count: 200, age: 86_400 },  // 24h
    removeOnFail:     { count: 500, age: 604_800 }, // 7 days
};

class QueueManager {
    constructor() {
        // Queues — لإضافة المهام
        this._queues  = {};
        // Workers — لتنفيذ المهام
        this._workers = {};
        // QueueEvents — لمراقبة الأحداث (اختياري)
        this._events  = {};

        this._isRunning = false;

        // Handlers مُسجَّلة من الخارج (يُضيفها JobScheduler أو Bootstrap)
        this._handlers = {};
    }

    // ══════════════════════════════════════════════════════════════════════════
    // التهيئة
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * تسجيل handler لنوع مهمة معين
     * يجب استدعاؤه قبل start()
     *
     * @param {string}   queueName - اسم الـ Queue (من QUEUES)
     * @param {string}   jobType   - نوع المهمة (مثل 'send_private_message')
     * @param {Function} handler   - async (job) => void
     */
    registerHandler(queueName, jobType, handler) {
        if (!this._handlers[queueName]) this._handlers[queueName] = {};
        this._handlers[queueName][jobType] = handler;
        console.log(`[QueueManager] Handler registered: ${queueName}::${jobType}`);
    }

    /**
     * بدء تشغيل جميع القوائم والـ Workers
     */
    async start() {
        if (this._isRunning) return;

        // إنشاء Queues
        for (const name of Object.values(QUEUES)) {
            this._queues[name] = new Queue(name, {
                connection:         getBullMQConnection(),
                defaultJobOptions:  DEFAULT_JOB_OPTIONS,
            });
        }

        // إنشاء Workers بإعدادات مناسبة لكل Queue
        this._workers[QUEUES.CAMPAIGNS] = new Worker(
            QUEUES.CAMPAIGNS,
            (job) => this._dispatch(QUEUES.CAMPAIGNS, job),
            {
                connection:  getBullMQConnection(),
                concurrency: parseInt(process.env.CAMPAIGN_CONCURRENCY || '3', 10),
                limiter:     { max: 5, duration: 1_000 }, // 5 رسائل/ثانية حداً أقصى
            }
        );

        this._workers[QUEUES.SYNC] = new Worker(
            QUEUES.SYNC,
            (job) => this._dispatch(QUEUES.SYNC, job),
            {
                connection:  getBullMQConnection(),
                concurrency: parseInt(process.env.SYNC_CONCURRENCY || '5', 10),
            }
        );

        this._workers[QUEUES.NOTIFICATIONS] = new Worker(
            QUEUES.NOTIFICATIONS,
            (job) => this._dispatch(QUEUES.NOTIFICATIONS, job),
            {
                connection:  getBullMQConnection(),
                concurrency: 10,
            }
        );

        // تسجيل أحداث Workers
        for (const [name, worker] of Object.entries(this._workers)) {
            worker.on('completed', (job) =>
                console.log(`[QueueManager:${name}] ✅ Job ${job.id} (${job.name}) completed`)
            );
            worker.on('failed', (job, err) =>
                console.error(`[QueueManager:${name}] ❌ Job ${job?.id} (${job?.name}) failed: ${err.message}`)
            );
            worker.on('error', (err) =>
                console.error(`[QueueManager:${name}] Worker error: ${err.message}`)
            );
        }

        this._isRunning = true;
        console.log('[QueueManager] ✅ All queues and workers started.');
        console.log(`[QueueManager] Queues: ${Object.values(QUEUES).join(', ')}`);
    }

    /**
     * إيقاف جميع Workers والـ Queues بشكل آمن
     */
    async stop() {
        if (!this._isRunning) return;
        this._isRunning = false;

        // إيقاف Workers أولاً (ينتظر اكتمال المهام الجارية)
        for (const [name, worker] of Object.entries(this._workers)) {
            try {
                await worker.close();
                console.log(`[QueueManager] Worker ${name} stopped.`);
            } catch (err) {
                console.warn(`[QueueManager] Worker ${name} close error: ${err.message}`);
            }
        }

        // ثم إغلاق Queues
        for (const [name, queue] of Object.entries(this._queues)) {
            try {
                await queue.close();
                console.log(`[QueueManager] Queue ${name} closed.`);
            } catch (err) {
                console.warn(`[QueueManager] Queue ${name} close error: ${err.message}`);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Dispatcher الداخلي
    // ══════════════════════════════════════════════════════════════════════════

    async _dispatch(queueName, job) {
        const handler = this._handlers[queueName]?.[job.name];

        if (!handler) {
            console.warn(`[QueueManager] No handler for ${queueName}::${job.name} — skipping.`);
            return;
        }

        await handler(job);
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Campaigns Queue API
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إضافة رسالة حملة عامة (Broadcast)
     * يستبدل setTimeout في CampaignService
     *
     * @param {string} accountId
     * @param {string} campaignId
     * @param {object} payload    - { targetId, targetType, adLibraryId, messageIndex }
     * @param {number} delayMs    - تأخير بالمللي ثانية (بدلاً من setTimeout)
     */
    async enqueueCampaignMessage(accountId, campaignId, payload, delayMs = 0) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        return queue.add('send_campaign_message', {
            accountId,
            campaignId,
            ...payload,
        }, {
            delay:    delayMs,
            priority: 5,
            jobId:    `campaign:${campaignId}:${payload.targetId}:${Date.now()}`,
        });
    }

    /**
     * إضافة رسالة حملة خاصة (Private Campaign)
     * يستبدل setTimeout في PrivateCampaignService
     *
     * @param {string} accountId
     * @param {string} campaignId
     * @param {object} payload    - { phone, message, mediaUrl, mediaType, ... }
     * @param {number} delayMs    - تأخير بالمللي ثانية
     */
    async enqueuePrivateCampaignMessage(accountId, campaignId, payload, delayMs = 0) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        return queue.add('send_private_message', {
            accountId,
            campaignId,
            ...payload,
        }, {
            delay:    delayMs,
            priority: 5,
            jobId:    `private:${campaignId}:${payload.phone}:${Date.now()}`,
        });
    }

    /**
     * إلغاء جميع مهام حملة معينة (عند إيقاف/حذف الحملة)
     * @param {string} campaignId
     */
    async cancelCampaignJobs(campaignId) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        try {
            // إلغاء المهام المؤجلة فقط — الجارية لا يمكن إلغاؤها
            const delayed = await queue.getDelayed();
            const toCancel = delayed.filter(j =>
                j.data.campaignId === campaignId
            );

            for (const job of toCancel) {
                await job.remove();
            }

            console.log(`[QueueManager] Cancelled ${toCancel.length} delayed jobs for campaign ${campaignId}`);
            return toCancel.length;
        } catch (err) {
            console.error(`[QueueManager] cancelCampaignJobs error: ${err.message}`);
            return 0;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Sync Queue API
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إضافة مهمة مزامنة مجموعات
     * @param {string} accountId
     * @param {object} options   - { priority, delay }
     */
    async enqueueGroupSync(accountId, options = {}) {
        const queue = this._getQueue(QUEUES.SYNC);
        return queue.add('sync_groups', { accountId }, {
            delay:    options.delay    || 0,
            priority: options.priority || 10,
            jobId:    `sync:groups:${accountId}:${Date.now()}`,
            // منع تكرار المهمة خلال 30 ثانية لنفس الحساب
            deduplication: { id: `sync:groups:${accountId}`, ttl: 30_000 },
        });
    }

    /**
     * إضافة مهمة مزامنة جهات الاتصال
     */
    async enqueueContactSync(accountId, options = {}) {
        const queue = this._getQueue(QUEUES.SYNC);
        return queue.add('sync_contacts', { accountId }, {
            delay:    options.delay    || 0,
            priority: options.priority || 15,
            jobId:    `sync:contacts:${accountId}:${Date.now()}`,
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Notifications Queue API
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إرسال إشعار داخلي للـ frontend عبر Queue
     * @param {object} notification - { type, title, message, userId? }
     */
    async enqueueNotification(notification) {
        const queue = this._getQueue(QUEUES.NOTIFICATIONS);
        return queue.add('send_notification', notification, {
            priority: 1, // أولوية عالية للإشعارات
        });
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Stats & Monitoring
    // ══════════════════════════════════════════════════════════════════════════

    /**
     * إحصائيات جميع الـ Queues — يُستخدم في /health endpoint
     */
    async getStats() {
        const stats = {};
        for (const [name, queue] of Object.entries(this._queues)) {
            try {
                const counts = await queue.getJobCounts(
                    'waiting', 'active', 'delayed', 'failed', 'completed'
                );
                stats[name] = counts;
            } catch (err) {
                stats[name] = { error: err.message };
            }
        }
        return stats;
    }

    /**
     * إحصائيات حملة معينة — عدد المهام المؤجلة/الجارية/المكتملة/الفاشلة
     */
    async getCampaignStats(campaignId) {
        const queue = this._getQueue(QUEUES.CAMPAIGNS);
        try {
            const [waiting, active, delayed, failed, completed] = await Promise.all([
                queue.getWaiting(),
                queue.getActive(),
                queue.getDelayed(),
                queue.getFailed(),
                queue.getCompleted(),
            ]);

            const filter = (jobs) => jobs.filter(j => j.data.campaignId === campaignId).length;

            return {
                waiting:   filter(waiting),
                active:    filter(active),
                delayed:   filter(delayed),
                failed:    filter(failed),
                completed: filter(completed),
            };
        } catch (err) {
            console.error(`[QueueManager] getCampaignStats error: ${err.message}`);
            return null;
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    // Helpers
    // ══════════════════════════════════════════════════════════════════════════

    _getQueue(name) {
        const queue = this._queues[name];
        if (!queue) {
            throw new Error(`[QueueManager] Queue "${name}" not found. Did you call start()?`);
        }
        return queue;
    }

    /** الوصول المباشر لـ Queue بالاسم (للاستخدامات المتقدمة) */
    getQueue(name) {
        return this._getQueue(name);
    }

    /** أسماء الـ Queues المتاحة */
    static get QUEUES() {
        return QUEUES;
    }
}

// Singleton
module.exports = new QueueManager();
