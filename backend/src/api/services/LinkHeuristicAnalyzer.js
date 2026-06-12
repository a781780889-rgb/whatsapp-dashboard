class LinkHeuristicAnalyzer {
    constructor() {
        // Spam indicators
        this.spamKeywords = [
            'free', 'win', 'cash', 'money', 'prize', 'click here', 'bonus', 'claim',
            'مجانا', 'اربح', 'كاش', 'جوائز', 'هديتك', 'اضغط هنا', 'اربح ايفون', 'فوركس'
        ];
        
        this.suspiciousDomains = [
            'bit.ly', 'tinyurl.com', 'shorte.st', 'adf.ly', 'ouo.io', 'clickbank.net'
        ];

        this.trustedDomains = [
            'youtube.com', 'google.com', 'github.com', 'linkedin.com', 'twitter.com', 'x.com',
            'facebook.com', 'instagram.com', 'tiktok.com', 'wikipedia.org', 'amazon.com'
        ];
    }

    /**
     * Evaluate a link and its surrounding text
     * Returns: { is_spam: boolean, rating: number, summary: string }
     */
    evaluate(url, domain, contextText) {
        let isSpam = false;
        let rating = 3; // Default average rating
        let spamScore = 0;
        let reasons = [];

        const lowerContext = contextText ? contextText.toLowerCase() : '';
        const lowerUrl = url.toLowerCase();

        // 1. Check Suspicious Domains
        if (this.suspiciousDomains.some(d => domain.includes(d))) {
            spamScore += 3;
            reasons.push("رابط مختصر أو مشبوه.");
        }

        // 2. Check Spam Keywords in Context
        for (let keyword of this.spamKeywords) {
            if (lowerContext.includes(keyword)) {
                spamScore += 2;
                reasons.push(`يحتوي على كلمة ترويجية: ${keyword}`);
            }
        }

        // 3. Domain Length or weird patterns (e.g., lots of dashes or numbers)
        if (domain.length > 30 || /\d{4,}/.test(domain)) {
            spamScore += 1;
            reasons.push("اسم النطاق طويل أو غريب.");
        }

        // 4. Trusted Domains get a boost
        if (this.trustedDomains.some(d => domain.includes(d))) {
            rating += 1; // 4 stars default for trusted
            spamScore -= 2; // Reduce spam likelihood
        }

        // 5. Context length: If someone just drops a link without context, it's slightly suspicious but less valuable
        if (lowerContext.length < url.length + 10 && !this.trustedDomains.some(d => domain.includes(d))) {
            rating -= 1;
            reasons.push("رابط تم نشره بدون سياق أو شرح.");
        }

        // Determine Spam
        if (spamScore >= 3) {
            isSpam = true;
            rating = 1;
        } else if (spamScore > 0) {
            rating = Math.max(1, rating - 1);
        }

        // Generate a local "AI Summary" based on heuristics
        let summary = "تم التحليل محلياً: ";
        if (isSpam) {
            summary += "⚠ رابط ذو احتمالية عالية ليكون بريد مزعج (Spam) أو احتيال. الأسباب: " + reasons.join(" ");
        } else if (this.trustedDomains.some(d => domain.includes(d))) {
            summary += `✅ رابط آمن وموثوق من منصة معروفة (${domain}).`;
        } else {
            summary += "ℹ️ رابط عادي، " + (reasons.length > 0 ? reasons.join(" ") : "لا توجد مؤشرات خطورة واضحة.");
        }

        // Cap rating between 1 and 5
        rating = Math.min(5, Math.max(1, rating));

        return {
            is_spam: isSpam,
            rating: rating,
            summary: summary
        };
    }
}

module.exports = new LinkHeuristicAnalyzer();
