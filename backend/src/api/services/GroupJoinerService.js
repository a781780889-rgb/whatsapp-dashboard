'use strict';
/**
 * GroupJoinerService — نظام الانضمام التلقائي المتقدم للمجموعات
 *
 * الميزات الجديدة (الجزء الثالث):
 * ─────────────────────────────
 * أوضاع الانضمام:
 *   • immediate  — الانضمام الفوري
 *   • delayed    — الانضمام بعد فاصل زمني محدد
 *   • scheduled  — الانضمام في وقت مجدول
 *
 * الفاصل الزمني (للوضع المؤجل):
 *   10s / 30s / 60s / 300s / custom
 *
 * توزيع الحسابات:
 *   single   — حساب واحد فقط
 *   pair     — حسابان بالتناوب
 *   multiple — عدة حسابات محددة
 *   all      — جميع الحسابات المتاحة
 */
const WhatsAppManager = require('../../bot/WhatsAppManager');

class GroupJoinerService {
    constructor() {
        this._queue             = [];   // قائمة الانتظار
        this._processing        = false;
        this._results           = [];   // آخر 100 نتيجة
        this._scheduledTimers   = [];   // مؤقتات الجدولة
        this._totalProcessed    = 0;
        this._totalSucceeded    = 0;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  جدولة الانضمام التلقائي
    // ══════════════════════════════════════════════════════════════════════════
    /**
     * @param {Array} linksData        [{accountId, link, linkId}]
     * @param {Object} options         خيارات الانضمام
     * @param {string} options.joinMode         'immediate'|'delayed'|'scheduled'
     * @param {number} options.delaySeconds     10|30|60|300|N (للوضع المؤجل)
     * @param {string} options.distributionMode 'single'|'pair'|'multiple'|'all'
     * @param {Array}  options.accountIds       معرفات الحسابات المحددة
     * @param {string} options.scheduledAt      ISO string (للوضع المجدول)
     * @returns {number} عدد الروابط المجدولة
     */
    async scheduleAutoJoin(linksData, options = {}) {
        if (!Array.isArray(linksData)) linksData = [linksData];
        const valid = linksData.filter(l => l && l.link);
        if (valid.length === 0) return 0;

        const {
            joinMode         = 'immediate',
            delaySeconds     = 30,
            distributionMode = 'single',
            accountIds       = [],
            scheduledAt      = null,
        } = options;

        // حل قائمة الحسابات المستخدمة
        const resolvedAccounts = this._resolveAccounts(distributionMode, accountIds, valid);
        if (resolvedAccounts.length === 0) {
            console.warn('[GroupJoiner] No valid accounts to join with!');
            return 0;
        }

        // توزيع الروابط على الحسابات (round-robin)
        const items = valid.map((link, i) => ({
            accountId:    resolvedAccounts[i % resolvedAccounts.length],
            link:         link.link || link.url,
            linkId:       link.linkId || link.id,
            joinMode,
            delaySeconds: (joinMode === 'delayed') ? Math.max(1, delaySeconds) : 0,
        }));

        // ── وضع مجدول: انتظر حتى الوقت المحدد ──────────────────────────────
        if (joinMode === 'scheduled' && scheduledAt) {
            const ms = new Date(scheduledAt).getTime() - Date.now();
            if (ms > 100) {
                console.log(`[GroupJoiner] Scheduling ${items.length} joins at ${scheduledAt} (in ${Math.round(ms/1000)}s)`);
                const timer = setTimeout(() => {
                    const immediateItems = items.map(it => ({ ...it, joinMode: 'immediate', delaySeconds: 0 }));
                    this._queue.push(...immediateItems);
                    if (!this._processing) {
                        this._processQueue().catch(e => console.error('[GroupJoiner]', e));
                    }
                }, ms);
                this._scheduledTimers.push(timer);
                return items.length;
            }
            // إذا كان الوقت قد مضى → انضمام فوري
        }

        // ── وضع فوري أو مؤجل: أضف للقائمة مباشرة ────────────────────────
        this._queue.push(...items);
        console.log(`[GroupJoiner] Queued ${items.length} links. Total queue: ${this._queue.length}`);

        if (!this._processing) {
            this._processQueue().catch(e => console.error('[GroupJoiner] Queue error:', e));
        }
        return items.length;
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  حالة القائمة
    // ══════════════════════════════════════════════════════════════════════════
    getQueue() {
        return {
            pending:        this._queue.length,
            processing:     this._processing,
            totalProcessed: this._totalProcessed,
            totalSucceeded: this._totalSucceeded,
            items:          this._queue.slice(0, 20),
            results:        this._results.slice(-20),
        };
    }

    clearQueue() {
        this._queue = [];
        this._scheduledTimers.forEach(t => clearTimeout(t));
        this._scheduledTimers = [];
        console.log('[GroupJoiner] Queue cleared.');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  تحليل الحسابات
    // ══════════════════════════════════════════════════════════════════════════
    _resolveAccounts(mode, selectedIds, linksData) {
        // إذا لم تُحدد حسابات، استخدم الحساب من كل رابط
        if (!selectedIds || selectedIds.length === 0) {
            return [...new Set(linksData.map(l => l.accountId).filter(Boolean))];
        }
        switch (mode) {
            case 'all':      return selectedIds;
            case 'multiple': return selectedIds;
            case 'pair':     return selectedIds.slice(0, 2);
            case 'single':
            default:         return [selectedIds[0]];
        }
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  معالجة القائمة
    // ══════════════════════════════════════════════════════════════════════════
    async _processQueue() {
        if (this._processing) return;
        this._processing = true;
        console.log('[GroupJoiner] Processing queue...');

        while (this._queue.length > 0) {
            const item = this._queue.shift();

            // ── تطبيق التأخير للوضع المؤجل ──────────────────────────────────
            if (item.delaySeconds > 0) {
                console.log(`[GroupJoiner] Waiting ${item.delaySeconds}s before: ${item.link}`);
                await new Promise(r => setTimeout(r, item.delaySeconds * 1000));
            }

            const result = await this._joinGroup(item);
            this._totalProcessed++;
            if (result.success) this._totalSucceeded++;

            this._results.push({ ...item, result, ts: new Date().toISOString() });
            if (this._results.length > 100) this._results.shift();

            // تأخير عشوائي لمنع الحظر (3–8 ثواني)
            const antiBan = 3000 + Math.floor(Math.random() * 5000);
            await new Promise(r => setTimeout(r, antiBan));
        }

        this._processing = false;
        console.log('[GroupJoiner] Queue drained.');
    }

    // ══════════════════════════════════════════════════════════════════════════
    //  الانضمام لمجموعة واحدة
    // ══════════════════════════════════════════════════════════════════════════
    async _joinGroup({ accountId, link, linkId }) {
        try {
            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                console.warn(`[GroupJoiner] No session for account ${accountId}`);
                return { success: false, error: 'الحساب غير متصل' };
            }

            const code = this._extractInviteCode(link);
            if (!code) {
                return { success: false, error: 'رابط دعوة غير صالح أو غير مدعوم' };
            }

            const groupId = await sock.groupAcceptInvite(code);
            console.log(`[GroupJoiner] ✅ Joined ${groupId} via account ${accountId}`);
            return { success: true, groupId };

        } catch (err) {
            console.error(`[GroupJoiner] ❌ ${link}:`, err.message);
            const friendly = this._friendlyError(err.message);
            return { success: false, error: friendly };
        }
    }

    _extractInviteCode(link) {
        if (!link) return null;
        const patterns = [
            /chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,})/,
            /whatsapp\.com\/invite\/([A-Za-z0-9_-]+)/,
        ];
        for (const p of patterns) {
            const m = link.match(p);
            if (m?.[1]) return m[1];
        }
        return null;
    }

    _friendlyError(msg) {
        if (!msg) return 'خطأ غير معروف';
        if (msg.includes('not-authorized'))    return 'غير مصرح للانضمام (رابط منتهي أو مجموعة مغلقة)';
        if (msg.includes('bad-request'))       return 'طلب غير صالح';
        if (msg.includes('connection'))        return 'خطأ في الاتصال';
        return msg;
    }
}

module.exports = new GroupJoinerService();
