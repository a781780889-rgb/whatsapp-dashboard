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

async function usePostgreSQLAuthState(accountId, db) {
    // ── مساعدات DB ────────────────────────────────────────────────────────────
    async function readData(key) {
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
    }

    async function writeData(key, value) {
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
    }

    async function removeData(key) {
        try {
            await db.run(
                `DELETE FROM session_data WHERE account_id = $1 AND key = $2`,
                [accountId, key]
            );
        } catch {}
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

module.exports = { usePostgreSQLAuthState, deletePostgreSQLAuthState };
