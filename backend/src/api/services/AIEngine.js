'use strict';
/**
 * AIEngine — Claude API Integration
 * Section 14.1 / Phase 1 (2025) من وثيقة التحليل:
 *
 * Phase 1 المُطبَّق الآن:
 * - Campaign Copy Generation عبر Claude API (Anthropic) أو OpenAI.
 * - AI_PROVIDER يُحدد المزوّد عبر متغير البيئة.
 * - Batch API cost-effective للإنشاء الجماعي.
 *
 * Phase 2 (2026): AI-Powered Campaign Optimization.
 * Phase 3 (2027): Autonomous Campaign Agent.
 */

class AIEngine {
    constructor() {
        this.provider   = process.env.AI_PROVIDER || 'none'; // none | claude | openai
        this.anthropicKey = process.env.ANTHROPIC_API_KEY;
        this.openaiKey    = process.env.OPENAI_API_KEY;
        this._anthropic   = null;
    }

    _getAnthropicClient() {
        if (this._anthropic) return this._anthropic;
        const Anthropic = require('@anthropic-ai/sdk');
        if (!this.anthropicKey) throw new Error('[AIEngine] ANTHROPIC_API_KEY not set.');
        this._anthropic = new Anthropic({ apiKey: this.anthropicKey });
        return this._anthropic;
    }

    /**
     * Generate highly converting Ad Copy (Feature 201)
     * Section 14.1 Phase 1: Campaign Copy Generation via Claude API
     */
    async generateAdCopy(productName, targetAudience, tone = 'professional', language = 'ar') {
        if (this.provider === 'none') {
            return `🚀 عرض خاص على ${productName} خصيصاً لـ ${targetAudience}! تواصل معنا الآن للحصول على الخصم.`;
        }

        if (this.provider === 'claude') {
            return this._generateWithClaude(productName, targetAudience, tone, language);
        }

        if (this.provider === 'openai') {
            return this._generateWithOpenAI(productName, targetAudience, tone, language);
        }

        return `الإعلان جاهز لـ ${productName}`;
    }

    async _generateWithClaude(productName, targetAudience, tone, language) {
        try {
            const client = this._getAnthropicClient();
            const langLabel = language === 'ar' ? 'العربية' : 'English';

            const message = await client.messages.create({
                model:      'claude-sonnet-4-20250514',
                max_tokens: 300,
                messages: [{
                    role: 'user',
                    content: `أنت خبير تسويق رقمي متخصص في WhatsApp Marketing.
اكتب نص إعلاني قصير وجذّاب (3-4 جمل فقط) باللغة ${langLabel} بأسلوب ${tone} لـ:
المنتج: ${productName}
الجمهور المستهدف: ${targetAudience}

القواعد:
- ابدأ بجملة تشويق قوية
- اذكر فائدة واحدة محددة وقيّمة
- اختتم بـ Call-to-Action واضح
- لا تستخدم كلمات عامة ومبتذلة
- الحد الأقصى: 250 كلمة`
                }]
            });

            return message.content[0]?.text || `عرض خاص على ${productName}!`;
        } catch (err) {
            console.error('[AIEngine] Claude API error:', err.message);
            return `🚀 ${productName} — عرض لا يُفوَّت لـ ${targetAudience}. تواصل معنا الآن!`;
        }
    }

    async _generateWithOpenAI(productName, targetAudience, tone, language) {
        try {
            const { default: OpenAI } = await import('openai');
            if (!this.openaiKey) throw new Error('OPENAI_API_KEY not set.');
            const openai   = new OpenAI({ apiKey: this.openaiKey });
            const langLabel = language === 'ar' ? 'Arabic' : 'English';

            const completion = await openai.chat.completions.create({
                model: 'gpt-4o-mini',
                messages: [{
                    role: 'system',
                    content: 'You are a WhatsApp marketing expert. Write short, high-converting ad copy.'
                }, {
                    role: 'user',
                    content: `Write a short ${tone} ad in ${langLabel} for: ${productName}, audience: ${targetAudience}. Max 250 words.`
                }],
                max_tokens: 300,
            });

            return completion.choices[0]?.message?.content || `عرض على ${productName}!`;
        } catch (err) {
            console.error('[AIEngine] OpenAI error:', err.message);
            return `🚀 ${productName} — عرض خاص لـ ${targetAudience}!`;
        }
    }

    /**
     * Analyze Campaign Performance & Recommend Actions (Feature 250)
     */
    async analyzePerformance(metrics) {
        const { ctr, costPerClick, totalSpent } = metrics;
        const recommendations = [];
        if (ctr < 1.5)        recommendations.push('تغيير النص الإعلاني (CTR منخفض)');
        if (costPerClick > 5)  recommendations.push('إيقاف الإعلان: تكلفة النقرة مرتفعة جداً');

        // Phase 2 (2026): سيتم تحليل الأداء عبر Claude API هنا
        return {
            status: recommendations.length > 0 ? 'needs_optimization' : 'optimal',
            recommendations
        };
    }

    /**
     * Auto-Bidding / Auto-Pause (Feature 275)
     */
    async autoOptimizeCampaign(campaignId, metrics) {
        const analysis = await this.analyzePerformance(metrics);
        if (analysis.recommendations.some(r => r.includes('إيقاف'))) {
            console.log(`[AIEngine] Auto-pausing campaign ${campaignId}: poor performance.`);
            return { action: 'paused', reason: 'High CPC' };
        }
        return { action: 'none' };
    }
}

module.exports = new AIEngine();
