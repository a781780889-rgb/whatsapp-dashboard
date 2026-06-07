const DatabaseManager = require('../../database/DatabaseManager');
const crypto = require('crypto');

class LinkExtractorService {
    constructor() {
        // Advanced regex to catch most URLs (http, https, www, domain.tld)
        this.urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.[a-zA-Z]{2,}(?:\/[^\s]*)?)/gi;
    }

    /**
     * Process an incoming message to extract and save links
     */
    async processMessage(accountId, messageData) {
        const { text, senderJid, groupJid, messageId } = messageData;
        if (!text) return;

        const rawLinks = text.match(this.urlRegex) || [];
        if (rawLinks.length === 0) return;

        const accountDB = await DatabaseManager.getAccountDB(accountId);

        for (let rawLink of rawLinks) {
            // Clean up trailing punctuation if caught by regex
            rawLink = rawLink.replace(/[.,;!?]$/, '');
            
            // Ensure protocol for URL parsing
            const urlToParse = rawLink.startsWith('http') ? rawLink : `https://${rawLink}`;
            
            try {
                const parsedUrl = new URL(urlToParse);
                const domain = parsedUrl.hostname.replace('www.', '');

                // 1. Determine or create Category based on Domain
                const categoryId = await this._getOrCreateCategory(accountDB, domain);

                // 2. Prevent Duplicates (Check if URL exists)
                const existingLink = await accountDB.get(`SELECT id FROM extracted_links WHERE url = $1`, [rawLink]);
                if (existingLink) {
                    await accountDB.run(
                        `INSERT INTO link_logs (id, link_id, action, details) VALUES ($1, $2, 'duplicate_detected', $3)`,
                        [crypto.randomUUID(), existingLink.id, `Seen again in message ${messageId}`]
                    );
                    continue; // Skip inserting new link
                }

                // 3. Evaluate Context (Country, Region, Keywords)
                const context = this._extractContext(rawLink, domain, text);

                // 4. Evaluate using Heuristic Analyzer
                const LinkHeuristicAnalyzer = require('./LinkHeuristicAnalyzer');
                const analysis = LinkHeuristicAnalyzer.evaluate(rawLink, domain, text);

                // 5. Insert the Link
                const linkId = crypto.randomUUID();
                await accountDB.run(
                    `INSERT INTO extracted_links (id, url, domain, group_jid, sender_jid, message_id, category_id, status, ai_rating, ai_summary, is_spam, country, region, keywords)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11, $12, $13)`,
                    [linkId, rawLink, domain, groupJid || null, senderJid, messageId, categoryId, analysis.rating, analysis.summary, analysis.is_spam ? 1 : 0, context.country, context.region, context.keywords]
                );

                // 6. Log
                await accountDB.run(
                    `INSERT INTO link_logs (id, link_id, action, details) VALUES ($1, $2, 'extracted', $3)`,
                    [crypto.randomUUID(), linkId, `Auto-extracted. Spam: ${analysis.is_spam}`]
                );
                
                console.log(`[Account ${accountId}] Link extracted: ${rawLink} (Country: ${context.country})`);
            } catch (err) {
                // Invalid URL format caught by new URL()
                console.error(`[Account ${accountId}] Failed to parse link: ${rawLink}`, err.message);
            }
        }
    }

    _extractContext(url, domain, text) {
        let country = 'Unknown';
        let region = 'Unknown';
        let keywords = [];

        const lowerText = text.toLowerCase();
        
        // Basic Geo Heuristics
        if (domain.endsWith('.sa') || lowerText.includes('سعودي') || lowerText.includes('السعودية') || lowerText.includes('saudi') || lowerText.includes('+966')) {
            country = 'Saudi Arabia';
            if (lowerText.includes('رياض') || lowerText.includes('riyadh')) region = 'Riyadh';
            if (lowerText.includes('جدة') || lowerText.includes('jeddah')) region = 'Jeddah';
            if (lowerText.includes('دمام') || lowerText.includes('dammam')) region = 'Dammam';
        } else if (domain.endsWith('.ae') || lowerText.includes('امارات') || lowerText.includes('uae')) {
            country = 'UAE';
            if (lowerText.includes('دبي') || lowerText.includes('dubai')) region = 'Dubai';
        } else if (domain.endsWith('.eg') || lowerText.includes('مصر') || lowerText.includes('egypt') || lowerText.includes('+20')) {
            country = 'Egypt';
            if (lowerText.includes('قاهرة') || lowerText.includes('cairo')) region = 'Cairo';
        }

        // Keywords extraction
        const possibleKeywords = ['تسويق', 'عقارات', 'وظائف', 'بيع', 'شراء', 'تقنية', 'اخبار', 'سوق', 'متجر', 'تجارة', 'دورة', 'كورس'];
        possibleKeywords.forEach(kw => {
            if (lowerText.includes(kw)) keywords.push(kw);
        });

        return {
            country,
            region,
            keywords: keywords.join(', ')
        };
    }

    async _getOrCreateCategory(accountDB, domain) {
        // Simple heuristic: Use the main domain name as category (e.g., 'youtube' from 'youtube.com')
        const categoryName = domain.split('.')[0] || 'other';

        let category = await accountDB.get(`SELECT id FROM link_categories WHERE name = $1`, [categoryName]);
        
        if (!category) {
            const newId = crypto.randomUUID();
            // Generate a random pleasant color for UI
            const color = `hsl(${Math.floor(Math.random() * 360)}, 70%, 60%)`;
            await accountDB.run(
                `INSERT INTO link_categories (id, name, color) VALUES ($1, $2, $3)`,
                [newId, categoryName, color]
            );
            return newId;
        }

        return category.id;
    }
}

module.exports = new LinkExtractorService();
