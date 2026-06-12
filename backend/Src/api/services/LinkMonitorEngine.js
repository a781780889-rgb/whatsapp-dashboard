'use strict';
/**
 * LinkMonitorEngine — محرك مراقبة الروابط المتقدم
 * يعمل في الخلفية لتتبع إحصائيات اكتشاف الروابط لكل حساب.
 *
 * المهام:
 * - مراقبة الرسائل الجديدة (يُستدعى من WhatsAppManager)
 * - تتبع روابط واتساب / تيليجرام / القنوات / المجموعات
 * - حفظ إحصائيات الاكتشاف لكل حساب
 * - توفير حالة المراقبة للـ API
 */

class LinkMonitorEngine {
    constructor() {
        // إحصائيات لكل حساب
        this._stats   = new Map();   // accountId → StatsObject
        this._active  = new Set();   // حسابات المراقبة النشطة
        this._history = new Map();   // accountId → آخر 50 رابط مكتشف
    }

    // ── تسجيل رسالة مفحوصة ─────────────────────────────────────────────────
    recordMessage(accountId) {
        const s = this._ensureStats(accountId);
        s.messagesScanned++;
        s.lastActivity = new Date().toISOString();
    }

    // ── تسجيل رابط مكتشف ──────────────────────────────────────────────────
    recordLink(accountId, linkType, url, groupJid) {
        const s = this._ensureStats(accountId);
        s.linksFound++;

        switch (linkType) {
            case 'whatsapp_group':   s.whatsappGroups++;   break;
            case 'whatsapp_channel': s.whatsappChannels++; break;
            case 'telegram':         s.telegramLinks++;     break;
            default:                 s.otherLinks++;
        }

        s.lastActivity = new Date().toISOString();

        // حفظ في التاريخ (آخر 50 رابط)
        if (!this._history.has(accountId)) {
            this._history.set(accountId, []);
        }
        const history = this._history.get(accountId);
        history.unshift({ url, linkType, groupJid, ts: s.lastActivity });
        if (history.length > 50) history.pop();
    }

    // ── تفعيل / إيقاف مراقبة حساب ─────────────────────────────────────────
    markActive(accountId) {
        this._active.add(accountId);
        this._ensureStats(accountId);
        console.log(`[LinkMonitor] 🟢 Account ${accountId} — monitoring ACTIVE`);
    }

    markInactive(accountId) {
        this._active.delete(accountId);
        console.log(`[LinkMonitor] 🔴 Account ${accountId} — monitoring INACTIVE`);
    }

    // ── حالة حساب محدد ────────────────────────────────────────────────────
    getAccountStatus(accountId) {
        const stats   = this._ensureStats(accountId);
        const history = this._history.get(accountId) || [];
        return {
            active:          this._active.has(accountId),
            accountId,
            ...stats,
            recentLinks:     history.slice(0, 10),
        };
    }

    // ── حالة جميع الحسابات ────────────────────────────────────────────────
    getAllStatus() {
        const result = [];
        const allIds = new Set([...this._stats.keys(), ...this._active]);
        for (const id of allIds) {
            result.push(this.getAccountStatus(id));
        }
        return result;
    }

    // ── إعادة تعيين إحصائيات حساب ─────────────────────────────────────────
    resetStats(accountId) {
        this._stats.delete(accountId);
        this._history.delete(accountId);
    }

    // ── الكائن الداخلي للإحصائيات ──────────────────────────────────────────
    _ensureStats(accountId) {
        if (!this._stats.has(accountId)) {
            this._stats.set(accountId, {
                messagesScanned:  0,
                linksFound:       0,
                whatsappGroups:   0,
                whatsappChannels: 0,
                telegramLinks:    0,
                otherLinks:       0,
                lastActivity:     null,
                startedAt:        new Date().toISOString(),
            });
        }
        return this._stats.get(accountId);
    }
}

module.exports = new LinkMonitorEngine();

