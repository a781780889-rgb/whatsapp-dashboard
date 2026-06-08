'use strict';
/**
 * GroupJoinerService — خدمة الانضمام التلقائي لمجموعات واتساب
 * يُستخدم من LinkController لجدولة الانضمام للروابط
 */
const WhatsAppManager = require('../../bot/WhatsAppManager');  // ✅ مسار صحيح

class GroupJoinerService {
    constructor() {
        this._queue      = [];      // قائمة الانتظار
        this._processing = false;   // هل نعالج الآن؟
        this._results    = [];      // نتائج آخر 50 عملية
    }

    // ── جدولة روابط للانضمام ────────────────────────────────────────────────
    /**
     * @param {Array<{accountId, link, linkId}>|{accountId, link, linkId}} linksData
     * @returns {number} عدد الروابط المجدولة
     */
    async scheduleAutoJoin(linksData) {
        if (!Array.isArray(linksData)) linksData = [linksData];
        const valid = linksData.filter(l => l && l.link && l.accountId);
        if (valid.length === 0) return 0;

        this._queue.push(...valid);
        console.log(`[GroupJoinerService] Queued ${valid.length} links. Total queue: ${this._queue.length}`);

        if (!this._processing) {
            this._processQueue().catch(err =>
                console.error('[GroupJoinerService] Queue error:', err.message)
            );
        }
        return valid.length;
    }

    // ── حالة القائمة ─────────────────────────────────────────────────────────
    getQueue() {
        return {
            pending:  this._queue.length,
            items:    this._queue.slice(0, 20),
            results:  this._results.slice(-20),
        };
    }

    // ── معالجة القائمة ───────────────────────────────────────────────────────
    async _processQueue() {
        if (this._processing) return;
        this._processing = true;

        while (this._queue.length > 0) {
            const item = this._queue.shift();
            const result = await this._joinGroup(item);
            this._results.push({ ...item, result, ts: new Date().toISOString() });
            if (this._results.length > 50) this._results.shift();

            // تأخير عشوائي لتجنب الحظر
            const delay = 3000 + Math.floor(Math.random() * 7000);
            await new Promise(r => setTimeout(r, delay));
        }

        this._processing = false;
        console.log('[GroupJoinerService] Queue drained.');
    }

    // ── الانضمام لمجموعة واحدة ───────────────────────────────────────────────
    async _joinGroup({ accountId, link, linkId }) {
        try {
            const sock = WhatsAppManager.getSession(accountId);
            if (!sock) {
                console.warn(`[GroupJoinerService] No session for account ${accountId}`);
                return { success: false, error: 'الحساب غير متصل' };
            }

            const code = this._extractInviteCode(link);
            if (!code) {
                return { success: false, error: 'رابط دعوة غير صالح' };
            }

            const groupId = await sock.groupAcceptInvite(code);
            console.log(`[GroupJoinerService] ✅ Joined group ${groupId} via account ${accountId}`);
            return { success: true, groupId };

        } catch (err) {
            console.error(`[GroupJoinerService] ❌ Failed to join ${link}:`, err.message);
            return { success: false, error: err.message };
        }
    }

    // ── استخراج كود الدعوة من الرابط ─────────────────────────────────────────
    _extractInviteCode(link) {
        if (!link) return null;
        const patterns = [
            /chat\.whatsapp\.com\/([A-Za-z0-9_-]+)/,
            /whatsapp\.com\/invite\/([A-Za-z0-9_-]+)/,
        ];
        for (const p of patterns) {
            const m = link.match(p);
            if (m?.[1]) return m[1];
        }
        return null;
    }
}

module.exports = new GroupJoinerService();
