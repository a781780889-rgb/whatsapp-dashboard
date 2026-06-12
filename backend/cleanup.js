'use strict';
/**
 * cleanup.js — Safe Database Cleanup Tool (PostgreSQL)
 *
 * الاستخدام:
 *   node cleanup.js              ← عرض تقرير + طلب تأكيد
 *   node cleanup.js --dry-run    ← عرض فقط، بدون أي حذف
 *   node cleanup.js --older-than=30  ← تغيير عمر السجلات (افتراضي: 30 يوم)
 */

require('dotenv').config();

const readline = require('readline');
const DRY_RUN      = process.argv.includes('--dry-run');
const olderThanArg = process.argv.find(a => a.startsWith('--older-than='));
const OLDER_THAN_DAYS = olderThanArg ? parseInt(olderThanArg.split('=')[1], 10) : 30;

const DatabaseManager = require('./src/database/DatabaseManager');

// ── Helpers ────────────────────────────────────────────────────────────────────
function ask(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, ans => { rl.close(); resolve(ans); }));
}

function section(title) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`  ${title}`);
    console.log('─'.repeat(60));
}

// ── Main ───────────────────────────────────────────────────────────────────────
async function main() {
    if (DRY_RUN) console.log('\n🔍  DRY RUN MODE — لن يتم حذف أي شيء\n');

    await DatabaseManager.init();
    const db = DatabaseManager.systemDB;

    // ── 1. تقرير: الحسابات المنفصلة القديمة ─────────────────────────────────
    section('1. الحسابات المنفصلة القديمة');
    const oldAccounts = await db.all(`
        SELECT id, name, status, updated_at
        FROM accounts
        WHERE status = 'disconnected'
          AND updated_at < NOW() - INTERVAL '${OLDER_THAN_DAYS} days'
        ORDER BY updated_at ASC
    `);
    console.log(`  وُجد: ${oldAccounts.length} حساب (أقدم من ${OLDER_THAN_DAYS} يوم)`);
    oldAccounts.forEach(a =>
        console.log(`  • [${a.id}] ${a.name}  (${a.status})  آخر تحديث: ${a.updated_at}`)
    );

    // ── 2. تقرير: الـ sessions المنتهية ──────────────────────────────────────
    section('2. بيانات الجلسات (session_data) المنتهية');
    const expiredSessions = await db.get(`
        SELECT COUNT(*) AS cnt FROM session_data
        WHERE expires_at IS NOT NULL AND expires_at < NOW()
    `).catch(() => ({ cnt: 0 }));
    console.log(`  وُجد: ${expiredSessions.cnt} جلسة منتهية`);

    // ── 3. تقرير: audit_log القديم (90 يوم) ──────────────────────────────────
    section('3. سجل المراجعة (audit_log) القديم');
    const oldAudit = await db.get(`
        SELECT COUNT(*) AS cnt FROM audit_log
        WHERE created_at < NOW() - INTERVAL '90 days'
    `).catch(() => ({ cnt: 0 }));
    console.log(`  وُجد: ${oldAudit.cnt} سجل أقدم من 90 يوم`);

    // ── 4. تقرير: login_attempts القديمة (30 يوم) ────────────────────────────
    section('4. محاولات تسجيل الدخول (login_attempts) القديمة');
    const oldLogins = await db.get(`
        SELECT COUNT(*) AS cnt FROM login_attempts
        WHERE created_at < NOW() - INTERVAL '${OLDER_THAN_DAYS} days'
    `).catch(() => ({ cnt: 0 }));
    console.log(`  وُجد: ${oldLogins.cnt} محاولة أقدم من ${OLDER_THAN_DAYS} يوم`);

    // ── 5. تقرير: refresh_tokens المنتهية ────────────────────────────────────
    section('5. Refresh Tokens المنتهية');
    const expiredTokens = await db.get(`
        SELECT COUNT(*) AS cnt FROM refresh_tokens
        WHERE expires_at < NOW()
    `).catch(() => ({ cnt: 0 }));
    console.log(`  وُجد: ${expiredTokens.cnt} token منتهي`);

    // ── ملخص ─────────────────────────────────────────────────────────────────
    section('ملخص');
    const total =
        parseInt(oldAccounts.length) +
        parseInt(expiredSessions.cnt) +
        parseInt(oldAudit.cnt) +
        parseInt(oldLogins.cnt) +
        parseInt(expiredTokens.cnt);
    console.log(`  إجمالي السجلات المُرشَّحة للحذف: ${total}`);

    if (DRY_RUN || total === 0) {
        if (total === 0) console.log('\n✅  لا يوجد شيء للحذف.\n');
        else console.log('\n🔍  DRY RUN — لم يُحذف شيء.\n');
        process.exit(0);
    }

    // ── تأكيد تفاعلي ─────────────────────────────────────────────────────────
    const answer = await ask('\n⚠️  هل تريد تنفيذ الحذف؟ اكتب "نعم" للتأكيد: ');
    if (answer.trim() !== 'نعم') {
        console.log('\n❌  تم الإلغاء — لم يُحذف شيء.\n');
        process.exit(0);
    }

    console.log('\n🗑️  جاري الحذف...\n');

    // ── تنفيذ الحذف ───────────────────────────────────────────────────────────

    // 2. حذف sessions المنتهية
    const r2 = await db.run(`DELETE FROM session_data WHERE expires_at IS NOT NULL AND expires_at < NOW()`).catch(() => null);
    console.log(`  ✅ session_data: حُذف ${r2?.rowCount ?? '?'} سجل`);

    // 3. حذف audit_log القديم
    const r3 = await db.run(`DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '90 days'`).catch(() => null);
    console.log(`  ✅ audit_log: حُذف ${r3?.rowCount ?? '?'} سجل`);

    // 4. حذف login_attempts القديمة
    const r4 = await db.run(`DELETE FROM login_attempts WHERE created_at < NOW() - INTERVAL '${OLDER_THAN_DAYS} days'`).catch(() => null);
    console.log(`  ✅ login_attempts: حُذف ${r4?.rowCount ?? '?'} سجل`);

    // 5. حذف refresh_tokens المنتهية
    const r5 = await db.run(`DELETE FROM refresh_tokens WHERE expires_at < NOW()`).catch(() => null);
    console.log(`  ✅ refresh_tokens: حُذف ${r5?.rowCount ?? '?'} سجل`);

    // 1. حذف الحسابات القديمة (مع schemas) — يأتي آخراً
    let deletedAccounts = 0;
    for (const acc of oldAccounts) {
        try {
            await DatabaseManager.dropAccountSchema(acc.id);
            await db.run(`DELETE FROM accounts WHERE id = $1`, [acc.id]);
            deletedAccounts++;
            console.log(`  ✅ حُذف الحساب: [${acc.id}] ${acc.name}`);
        } catch (err) {
            console.error(`  ❌ فشل حذف الحساب [${acc.id}]:`, err.message);
        }
    }
    console.log(`  ✅ accounts: حُذف ${deletedAccounts}/${oldAccounts.length} حساب`);

    console.log('\n✅  اكتمل التنظيف.\n');
    process.exit(0);
}

main().catch(err => {
    console.error('\n❌  خطأ غير متوقع:', err.message);
    process.exit(1);
});
