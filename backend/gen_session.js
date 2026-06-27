/**
 * gen_session.js — توليد session_string لحساب تيليجرام
 *
 * يُشغَّل مرة واحدة فقط محلياً (على جهازك أو Termux):
 *   node gen_session.js
 *
 * المتطلبات:
 *   npm install telegram input
 *
 * احصل على api_id و api_hash من: https://my.telegram.org
 * ثم انسخ الـ session_string وضعه في لوحة التحكم عند إضافة الحساب
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const input              = require('input');

(async () => {
    console.log('\n📱 مولّد Session String لتيليجرام\n');
    console.log('احصل على api_id و api_hash من: https://my.telegram.org\n');

    const apiId   = parseInt(await input.text('api_id: '));
    const apiHash = await input.text('api_hash: ');
    const phone   = await input.text('رقم الهاتف (مثال: +966xxxxxxxxx): ');

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
        connectionRetries: 3,
    });

    await client.start({
        phoneNumber:   async () => phone,
        phoneCode:     async () => await input.text('كود التحقق (أُرسل على تيليجرام): '),
        password:      async () => await input.text('كلمة مرور المصادقة الثنائية (اتركه فارغاً إن لم تكن مفعّلة): '),
        onError:       (err) => { console.error('خطأ:', err.message); process.exit(1); },
    });

    const sessionString = client.session.save();

    console.log('\n✅ تم إنشاء Session String بنجاح!\n');
    console.log('━'.repeat(60));
    console.log(sessionString);
    console.log('━'.repeat(60));
    console.log('\n📌 انسخ النص أعلاه وضعه في حقل "Session String" في لوحة التحكم\n');

    await client.disconnect();
    process.exit(0);
})();
