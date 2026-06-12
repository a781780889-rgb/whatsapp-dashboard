'use strict';
/**
 * LinkExtractorService — محرك استخراج الروابط المتقدم
 *
 * يكتشف ويصنف:
 * - روابط مجموعات واتساب:  chat.whatsapp.com/...
 * - روابط قنوات واتساب:    whatsapp.com/channel/...
 * - روابط مجموعات تيليجرام: t.me/...  / telegram.me/...
 * - روابط القنوات:          t.me/+... أو قنوات عامة
 * - روابط أخرى عامة
 */
const DatabaseManager = require('../../database/DatabaseManager');
const LinkMonitorEngine = require('./LinkMonitorEngine');
const crypto = require('crypto');

// ── أنماط الروابط ──────────────────────────────────────────────────────────
const PATTERNS = {
    WHATSAPP_GROUP:   /https?:\/\/chat\.whatsapp\.com\/([A-Za-z0-9_-]{20,})/gi,
    WHATSAPP_CHANNEL: /https?:\/\/(www\.)?whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/gi,
    TELEGRAM:         /https?:\/\/(t\.me|telegram\.me|telegram\.org)\/([A-Za-z0-9_+@-]+)/gi,
    GENERIC_URL:      /(https?:\/\/[^\s<>"]{4,})/gi,
};

class LinkExtractorService {
    constructor() {
        // Fallback regex for any URL
        this.urlRegex = /(https?:\/\/[^\s<>"]+)/gi;
    }

    /**
     * معالجة رسالة واردة واستخراج جميع أنواع الروابط منها
     */
    async processMessage(accountId, messageData) {
        const { text, senderJid, groupJid, messageId } = messageData;
        if (!text) return;

        // تسجيل الرسالة في محرك المراقبة
        LinkMonitorEngine.recordMessage(accountId);
        LinkMonitorEngine.markActive(accountId);

        const discovered = this._discoverLinks(text);
        if (discovered.length === 0) return;

        let accountDB;
        try {
            accountDB = await DatabaseManager.getAccountDB(accountId);
        } catch (err) {
            console.error(`[LinkExtractor] DB error for account ${accountId}:`, err.message);
            return;
        }

        for (const { url, linkType, inviteCode } of discovered) {
            try {
                await this._processLink(accountDB, accountId, {
                    url, linkType, inviteCode,
                    senderJid, groupJid, messageId, text,
                });
            } catch (err) {
                console.error(`[LinkExtractor] Failed processing ${url}:`, err.message);
            }
        }
    }

    // ── اكتشاف جميع الروابط في نص ─────────────────────────────────────────
    _discoverLinks(text) {
        const found = [];
        const seen  = new Set();

        const addLink = (url, linkType, inviteCode = null) => {
            const clean = url.replace(/[.,;!?)]+$/, '');
            if (!seen.has(clean)) {
                seen.add(clean);
                found.push({ url: clean, linkType, inviteCode });
            }
        };

        // 1. روابط مجموعات واتساب
        let m;
        const waGroupRe = new RegExp(PATTERNS.WHATSAPP_GROUP.source, 'gi');
        while ((m = waGroupRe.exec(text)) !== null) {
            addLink(m[0], 'whatsapp_group', m[1]);
        }

        // 2. روابط قنوات واتساب
        const waChannelRe = new RegExp(PATTERNS.WHATSAPP_CHANNEL.source, 'gi');
        while ((m = waChannelRe.exec(text)) !== null) {
            addLink(m[0], 'whatsapp_channel', m[2]);
        }

        // 3. روابط تيليجرام
        const tgRe = new RegExp(PATTERNS.TELEGRAM.source, 'gi');
        while ((m = tgRe.exec(text)) !== null) {
            // t.me/+ = دعوة لمجموعة خاصة، t.me/username = قناة/مجموعة عامة
            const path = m[2] || '';
            const tgType = path.startsWith('+') ? 'telegram_group' : 'telegram';
            addLink(m[0], tgType, path);
        }

        // 4. روابط عامة (إن لم تُكتشف بالأنماط أعلاه)
        const genericRe = new RegExp(PATTERNS.GENERIC_URL.source, 'gi');
        while ((m = genericRe.exec(text)) !== null) {
            const url = m[0].replace(/[.,;!?)]+$/, '');
            if (!seen.has(url)) {
                addLink(url, 'other');
            }
        }

        return found;
    }

    // ── معالجة رابط واحد ──────────────────────────────────────────────────
    async _processLink(accountDB, accountId, data) {
        const { url, linkType, inviteCode, senderJid, groupJid, messageId, text } = data;

        let parsedUrl, domain;
        try {
            const toParse = url.startsWith('http') ? url : `https://${url}`;
            parsedUrl = new URL(toParse);
            domain    = parsedUrl.hostname.replace('www.', '');
        } catch {
            return; // رابط غير صالح
        }

        // تجنب التكرار
        const existing = await accountDB.get(
            `SELECT id FROM extracted_links WHERE url = $1`, [url]
        );
        if (existing) {
            await accountDB.run(
                `INSERT INTO link_logs (id, link_id, action, details) VALUES ($1, $2, 'duplicate_detected', $3)`,
                [crypto.randomUUID(), existing.id, `Seen again in ${messageId}`]
            );
            return;
        }

        // تقييم الرابط
        const LinkHeuristicAnalyzer = require('./LinkHeuristicAnalyzer');
        const analysis = LinkHeuristicAnalyzer.evaluate(url, domain, text);
        const context  = this._extractContext(url, domain, text);
        const categoryId = await this._getOrCreateCategory(accountDB, domain, linkType);

        // حفظ الرابط
        const linkId = crypto.randomUUID();
        await accountDB.run(
            `INSERT INTO extracted_links
             (id, url, domain, link_type, invite_code, group_jid, sender_jid, message_id,
              category_id, discovered_by_account_id, status, ai_rating, ai_summary,
              is_spam, country, region, keywords)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11,$12,$13,$14,$15,$16)`,
            [
                linkId, url, domain, linkType, inviteCode || null,
                groupJid || null, senderJid, messageId,
                categoryId, accountId,
                analysis.rating, analysis.summary, analysis.is_spam ? 1 : 0,
                context.country, context.region, context.keywords,
            ]
        );

        // تسجيل حدث الاكتشاف
        await accountDB.run(
            `INSERT INTO link_logs (id, link_id, action, details) VALUES ($1, $2, 'extracted', $3)`,
            [crypto.randomUUID(), linkId, `نوع: ${linkType} | Spam: ${analysis.is_spam}`]
        );

        // إبلاغ محرك المراقبة
        LinkMonitorEngine.recordLink(accountId, linkType, url, groupJid);

        console.log(`[LinkExtractor][${accountId}] ✅ ${linkType}: ${url}`);
    }

    // ── استخراج السياق الجغرافي والكلمات المفتاحية ─────────────────────────
    _extractContext(url, domain, text) {
        let country  = 'Unknown';
        let region   = 'Unknown';
        let keywords = [];

        const t = (text || '').toLowerCase();

        if (domain.endsWith('.sa') || t.includes('سعودي') || t.includes('السعودية') || t.includes('saudi') || t.includes('+966')) {
            country = 'Saudi Arabia';
            if (t.includes('رياض') || t.includes('riyadh'))   region = 'Riyadh';
            if (t.includes('جدة')  || t.includes('jeddah'))   region = 'Jeddah';
            if (t.includes('دمام') || t.includes('dammam'))   region = 'Dammam';
            if (t.includes('مكة')  || t.includes('makkah'))   region = 'Makkah';
        } else if (domain.endsWith('.ae') || t.includes('امارات') || t.includes('uae')) {
            country = 'UAE';
            if (t.includes('دبي')     || t.includes('dubai'))     region = 'Dubai';
            if (t.includes('أبوظبي')  || t.includes('abudhabi'))  region = 'Abu Dhabi';
        } else if (domain.endsWith('.eg') || t.includes('مصر') || t.includes('egypt') || t.includes('+20')) {
            country = 'Egypt';
            if (t.includes('قاهرة') || t.includes('cairo')) region = 'Cairo';
        } else if (domain.endsWith('.kw') || t.includes('الكويت') || t.includes('kuwait')) {
            country = 'Kuwait';
        } else if (domain.endsWith('.qa') || t.includes('قطر') || t.includes('qatar')) {
            country = 'Qatar';
        } else if (domain.endsWith('.bh') || t.includes('البحرين') || t.includes('bahrain')) {
            country = 'Bahrain';
        } else if (domain.endsWith('.om') || t.includes('عمان') || t.includes('oman')) {
            country = 'Oman';
        }

        const kwList = [
            'تسويق', 'عقارات', 'وظائف', 'بيع', 'شراء', 'تقنية',
            'اخبار', 'سوق', 'متجر', 'تجارة', 'دورة', 'كورس',
            'صحة', 'رياضة', 'ترفيه', 'توظيف', 'استثمار',
        ];
        kwList.forEach(kw => { if (t.includes(kw)) keywords.push(kw); });

        return { country, region, keywords: keywords.join(', ') };
    }

    // ── تحديد / إنشاء تصنيف ────────────────────────────────────────────────
    async _getOrCreateCategory(accountDB, domain, linkType) {
        // اسم التصنيف: whatsapp/telegram أو اسم النطاق
        let categoryName;
        if (linkType === 'whatsapp_group' || linkType === 'whatsapp_channel') {
            categoryName = 'whatsapp';
        } else if (linkType === 'telegram' || linkType === 'telegram_group') {
            categoryName = 'telegram';
        } else {
            categoryName = domain.split('.')[0] || 'other';
        }

        let cat = await accountDB.get(
            `SELECT id FROM link_categories WHERE name = $1`, [categoryName]
        );
        if (!cat) {
            const newId = crypto.randomUUID();
            const colors = {
                whatsapp: '#25D366',
                telegram: '#2AABEE',
            };
            const color = colors[categoryName] || `hsl(${Math.floor(Math.random() * 360)}, 65%, 55%)`;
            await accountDB.run(
                `INSERT INTO link_categories (id, name, color) VALUES ($1, $2, $3)`,
                [newId, categoryName, color]
            );
            return newId;
        }
        return cat.id;
    }
}

module.exports = new LinkExtractorService();
