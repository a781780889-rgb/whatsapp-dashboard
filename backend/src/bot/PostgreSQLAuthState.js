'use strict';
/**
 * PostgreSQLAuthState — حفظ جلسات Baileys في PostgreSQL
 * ─────────────────────────────────────────────────────────────────────────────
 * بديل لـ useMultiFileAuthState الذي يحفظ في /tmp (يُمسح عند كل Railway deploy).
 * يحفظ كل مفاتيح وبيانات auth في جدول session_data الموجود في SystemDB.
 *
 * الاستخدام:
 *   const { state, saveCreds } = await usePostgreSQLAuthState(accountId, db);
 *
 * حيث db هو اتصال PostgreSQL (SystemDB أو أي pool يدعم .query())
 */

const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

const KEY_MAP = {
    'pre-key':        'preKeys',
    'session':        'sessions',
    'sender-key':     'senderKeys',
    'app-state-sync-key':       'appStateSyncKeys',
    'app-state-sync-version':   'appStateSyncVersion',
    'sender-key-memory':        'senderKeyMemory',
};

// [FIX-SESSION-RACE] قفل تسلسلي لكل مفتاح (account_id:key) — Baileys يستدعي
// keys.set() بشكل متكرر ومتزامن من مصادر متعددة (استقبال رسائل، مزامنة
// مجموعات، إرسال). كل نداء set() كان يكتب عبر Promise.all بلا أي ترتيب
// مضمون، فقد تصل كتابتان متزامنتان لنفس مفتاح "session:xxx" وتُطبَّق نسخة
// أقدم فوق أحدث بسبب تفاوت زمن استجابة PostgreSQL — مما يُفسد سلسلة تشفير
// Signal لهذه الجهة (يظهر لاحقاً كـ "Decrypted message with closed session"
// أو رسائل تُرسل بنجاح ظاهري لكن لا تصل أبداً لأن التشفير تحتها تالف).
// هذا القفل يضمن أن كل كتابة/قراءة لنفس المفتاح تنتظر اكتمال العملية السابقة
// عليه فعلياً في قاعدة البيانات قبل بدء التالية.
const _keyLocks = new Map(); // lockKey → Promise (آخر عملية قيد التنفيذ على هذا المفتاح)

function _withKeyLock(lockKey, fn) {
    const prev = _keyLocks.get(lockKey) || Promise.resolve();
    const next = prev.then(fn, fn); // ننفذ fn سواء نجحت العملية السابقة أو فشلت
    // نخزّن نسخة "صامتة" (لا ترمي) حتى لا تتراكم unhandled rejections في الخريطة
    _keyLocks.set(lockKey, next.catch(() => {}));
    return next;
}

async function usePostgreSQLAuthState(accountId, db) {
    // ── مساعدات DB ────────────────────────────────────────────────────────────
    function _lockKey(key) { return `${accountId}:${key}`; }

    async function readData(key) {
        return _withKeyLock(_lockKey(key), async () => {
            try {
                const row = await db.get(
                    `SELECT value FROM session_data WHERE account_id = $1 AND key = $2`,
                    [accountId, key]
                );
                if (!row?.value) return null;
                return JSON.parse(row.value, BufferJSON.reviver);
            } catch {
                return null;
            }
        });
    }

    async function writeData(key, value) {
        return _withKeyLock(_lockKey(key), async () => {
            try {
                const json = JSON.stringify(value, BufferJSON.replacer);
                await db.run(
                    `INSERT INTO session_data (account_id, key, value, updated_at)
                     VALUES ($1, $2, $3, NOW())
                     ON CONFLICT (account_id, key) DO UPDATE
                     SET value = EXCLUDED.value, updated_at = NOW()`,
                    [accountId, key, json]
                );
            } catch (err) {
                console.error(`[PostgreSQLAuthState] writeData error (${accountId}/${key}):`, err.message);
            }
        });
    }

    async function removeData(key) {
        return _withKeyLock(_lockKey(key), async () => {
            try {
                await db.run(
                    `DELETE FROM session_data WHERE account_id = $1 AND key = $2`,
                    [accountId, key]
                );
            } catch {}
        });
    }

    // ── تحميل الـ creds أو إنشاء جديدة ──────────────────────────────────────
    const creds = (await readData('creds')) || initAuthCreds();

    // ── state object الذي يتوقعه Baileys ─────────────────────────────────────
    const state = {
        creds,
        keys: {
            get: async (type, ids) => {
                const data = {};
                await Promise.all(
                    ids.map(async (id) => {
                        const key   = `${KEY_MAP[type] || type}:${id}`;
                        let   value = await readData(key);
                        if (type === 'app-state-sync-key' && value) {
                            value = proto.Message.AppStateSyncKeyData.fromObject(value);
                        }
                        data[id] = value;
                    })
                );
                return data;
            },

            set: async (data) => {
                const tasks = [];
                for (const [category, entries] of Object.entries(data)) {
                    for (const [id, value] of Object.entries(entries)) {
                        const dbKey = `${KEY_MAP[category] || category}:${id}`;
                        tasks.push(
                            value ? writeData(dbKey, value) : removeData(dbKey)
                        );
                    }
                }
                await Promise.all(tasks);
            },
        },
    };

    // ── saveCreds: يُستدعى عند تغيّر الـ creds ───────────────────────────────
    const saveCreds = async () => {
        await writeData('creds', state.creds);
    };

    return { state, saveCreds };
}

/**
 * حذف كل بيانات جلسة حساب معين (عند logout/reset)
 */
async function deletePostgreSQLAuthState(accountId, db) {
    try {
        await db.run(
            `DELETE FROM session_data WHERE account_id = $1`,
            [accountId]
        );
        console.log(`[PostgreSQLAuthState] Deleted auth state for account ${accountId}`);
    } catch (err) {
        console.error(`[PostgreSQLAuthState] deleteAuthState error:`, err.message);
    }
}

/**
 * [FIX-SESSION-RACE] مسح جلسات Signal (sessions/senderKeys) فقط، مع الإبقاء
 * على creds/preKeys — يُستخدم لتصحيح جلسات محادثة تالفة سابقاً (بسبب سباق
 * الكتابة القديم قبل إضافة القفل التسلسلي) دون قطع اتصال الحساب بأكمله
 * (الذي يتطلبه الحذف الكامل عبر deletePostgreSQLAuthState). Baileys يعيد
 * بناء أي جلسة محذوفة تلقائياً وبأمان عند أول تواصل تالٍ مع نفس الطرف.
 * @param {string} accountId
 * @param {object} db
 * @param {string} [targetPhone]  إن مُرِّر، يُمسح فقط جلسات هذا الرقم تحديداً
 *                                (بصيغة رقم بدون jid، مثال: '966597806430')
 */
async function repairCorruptedSessions(accountId, db, targetPhone = null) {
    try {
        const pattern = targetPhone
            ? `sessions:${targetPhone}%`
            : `sessions:%`;
        const result = await db.run(
            `DELETE FROM session_data WHERE account_id = $1 AND key LIKE $2`,
            [accountId, pattern]
        );
        console.log(`[PostgreSQLAuthState] repairCorruptedSessions: cleared session keys for account ${accountId}${targetPhone ? ` (phone=${targetPhone})` : ' (all)'}`);
        return true;
    } catch (err) {
        console.error(`[PostgreSQLAuthState] repairCorruptedSessions error:`, err.message);
        return false;
    }
}

module.exports = { usePostgreSQLAuthState, deletePostgreSQLAuthState, repairCorruptedSessions };
