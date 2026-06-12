'use strict';
/**
 * StartupValidator.js — Phase 1: PORT Configuration & Startup Validation
 *
 * المشكلة المُصلَحة:
 *   - Dockerfile كان يُحدِّد EXPOSE 8080 بينما .env يحمل PORT=5000 → خطأ على Railway.
 *   - لم يكن هناك تحقق شامل من المتغيرات عند البدء.
 *
 * الحل:
 *   - توحيد المنفذ عبر process.env.PORT (Railway يُعيِّنه تلقائياً).
 *   - قيمة افتراضية 5000 للتطوير المحلي فقط.
 *   - التحقق من صحة جميع المتغيرات المطلوبة قبل أي عملية.
 *   - رسائل خطأ واضحة تُوجِّه المطوِّر مباشرةً.
 */

const REQUIRED_VARS = [
    { key: 'JWT_SECRET',    hint: 'مثال: openssl rand -hex 64'             },
    { key: 'DATABASE_URL',  hint: 'مثال: postgresql://user:pass@host/db'   },
    { key: 'REDIS_URL',     hint: 'مثال: redis://default:pass@host:6379'   },
];

const RECOMMENDED_VARS = [
    { key: 'JWT_REFRESH_SECRET', hint: 'مطلوب لتجديد التوكنات بأمان' },
    { key: 'ADMIN_USERNAME',     hint: 'اسم مستخدم الأدمن الأولي'    },
    { key: 'ADMIN_PASSWORD',     hint: 'كلمة مرور الأدمن الأولية'    },
];

/**
 * resolvePort()
 * ─────────────
 * Railway يُعيِّن PORT ديناميكياً (عادةً 8080).
 * للتطوير المحلي نستخدم القيمة من .env أو 5000 كافتراضي.
 *
 * ⚠️  لا تُعيِّن PORT في Railway Variables — اتركه لـ Railway تلقائياً.
 */
function resolvePort() {
    const raw  = process.env.PORT;
    const port = parseInt(raw || '5000', 10);

    if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`[StartupValidator] PORT غير صالح: "${raw}". استخدام 5000 كافتراضي.`);
        return 5000;
    }

    return port;
}

/**
 * validate()
 * ──────────
 * يتحقق من المتغيرات المطلوبة ويُوقِف العملية عند غيابها.
 * يُطبع تحذيرات للمتغيرات الموصى بها فقط.
 */
function validate() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   WhatsApp SaaS Platform — Startup Validation   ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // ── فحص المتغيرات المطلوبة ────────────────────────────────────────────
    const missing = REQUIRED_VARS.filter(v => !process.env[v.key]);
    if (missing.length > 0) {
        console.error('[StartupValidator] ❌ متغيرات بيئة مفقودة:\n');
        missing.forEach(v => {
            console.error(`  ✗ ${v.key}`);
            console.error(`    → ${v.hint}\n`);
        });
        console.error('الحل: أضف هذه المتغيرات في Railway → Variables أو في ملف .env\n');
        process.exit(1);
    }

    // ── فحص المتغيرات الموصى بها (تحذير فقط) ────────────────────────────
    const recommended = RECOMMENDED_VARS.filter(v => !process.env[v.key]);
    if (recommended.length > 0) {
        console.warn('[StartupValidator] ⚠️  متغيرات موصى بها غير مُعيَّنة:');
        recommended.forEach(v => {
            console.warn(`  ! ${v.key} — ${v.hint}`);
        });
        console.warn('');
    }

    // ── فحص JWT_SECRET القوة ─────────────────────────────────────────────
    const jwtSecret = process.env.JWT_SECRET || '';
    if (jwtSecret.length < 32) {
        console.error('[StartupValidator] ❌ JWT_SECRET قصير جداً (أقل من 32 حرفاً).');
        console.error('   الحل: استخدم: openssl rand -hex 64\n');
        process.exit(1);
    }

    // ── تحديد المنفذ ─────────────────────────────────────────────────────
    const port = resolvePort();

    // ── ملخص ─────────────────────────────────────────────────────────────
    console.log('[StartupValidator] ✅ جميع المتغيرات المطلوبة موجودة.');
    console.log(`[StartupValidator] 🌐 المنفذ: ${port} (${process.env.PORT ? 'من environment' : 'افتراضي'})`);
    console.log(`[StartupValidator] 🗄️  قاعدة البيانات: ${maskUrl(process.env.DATABASE_URL)}`);
    console.log(`[StartupValidator] 📦 Redis: ${maskUrl(process.env.REDIS_URL)}`);
    console.log(`[StartupValidator] 🔧 NODE_ENV: ${process.env.NODE_ENV || 'development'}\n`);

    return port;
}

/** يُخفي كلمة المرور في URL للطباعة الآمنة */
function maskUrl(url = '') {
    try {
        const u = new URL(url);
        if (u.password) u.password = '***';
        return u.toString();
    } catch {
        return url.slice(0, 20) + '…';
    }
}

module.exports = { validate, resolvePort };
