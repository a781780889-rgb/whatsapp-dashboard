'use strict';
/**
 * BusinessAPIController — WhatsApp Cloud API (Business API)
 * يتعامل مع إعدادات WhatsApp Business API:
 *  - حفظ الإعدادات مع تشفير Access Token
 *  - اختبار الاتصال بـ Graph API
 *  - إدارة Webhook
 *  - إرسال الرسائل عبر Cloud API
 */
const crypto            = require('crypto');
const DatabaseManager   = require('../../database/DatabaseManager');

// ── مفتاح التشفير (32 بايت = AES-256) ──────────────────────────────────────
function getEncryptionKey() {
    const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'default-encryption-key-32bytes!!';
    return crypto.createHash('sha256').update(secret).digest(); // 32 bytes
}

function encryptToken(text) {
    if (!text) return null;
    const key = getEncryptionKey();
    const iv  = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptToken(encrypted) {
    if (!encrypted) return null;
    try {
        const [ivHex, dataHex] = encrypted.split(':');
        const key  = getEncryptionKey();
        const iv   = Buffer.from(ivHex, 'hex');
        const data = Buffer.from(dataHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

function maskToken(token) {
    if (!token || token.length < 8) return '***';
    return token.substring(0, 6) + '...' + token.substring(token.length - 4);
}

class BusinessAPIController {

    // ── جلب إعدادات Business API لحساب معين ──────────────────────────────────
    async getSettings(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            const row = await DatabaseManager.systemDB.get(
                `SELECT * FROM whatsapp_business_settings WHERE account_id = $1`, [id]
            );

            if (!row) {
                return res.json({ success: true, settings: null });
            }

            // إرجاع البيانات مع إخفاء الـ Token
            const rawToken = decryptToken(row.access_token_encrypted);
            return res.json({
                success: true,
                settings: {
                    id: row.id,
                    phone_number_id: row.phone_number_id,
                    business_account_id: row.business_account_id,
                    access_token_masked: rawToken ? maskToken(rawToken) : null,
                    verify_token: row.verify_token,
                    webhook_url: row.webhook_url,
                    is_verified: row.is_verified,
                    last_tested_at: row.last_tested_at,
                    created_at: row.created_at,
                    updated_at: row.updated_at,
                }
            });
        } catch (err) {
            console.error('[BusinessAPI] getSettings error:', err);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── حفظ / تحديث إعدادات Business API ─────────────────────────────────────
    async saveSettings(req, res) {
        try {
            const { id } = req.params;
            const {
                phone_number_id, business_account_id,
                access_token, verify_token, webhook_url
            } = req.body;

            // التحقق من الحقول المطلوبة
            if (!phone_number_id?.trim()) return res.status(400).json({ success: false, error: 'Phone Number ID مطلوب' });
            if (!business_account_id?.trim()) return res.status(400).json({ success: false, error: 'Business Account ID مطلوب' });
            if (!verify_token?.trim()) return res.status(400).json({ success: false, error: 'Verify Token مطلوب' });

            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            const existing = await DatabaseManager.systemDB.get(
                `SELECT id, access_token_encrypted FROM whatsapp_business_settings WHERE account_id = $1`, [id]
            );

            // إذا لم يُرسَل Token جديد، احتفظ بالقديم
            let tokenEncrypted = existing?.access_token_encrypted || null;
            if (access_token && access_token.trim()) {
                tokenEncrypted = encryptToken(access_token.trim());
            }

            const baseWebhookUrl = process.env.APP_URL || process.env.RAILWAY_PUBLIC_DOMAIN
                ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
                : '';
            const resolvedWebhook = webhook_url?.trim() || `${baseWebhookUrl}/api/v1/webhook/whatsapp/${id}`;

            if (existing) {
                await DatabaseManager.systemDB.run(
                    `UPDATE whatsapp_business_settings
                     SET phone_number_id = $1, business_account_id = $2,
                         access_token_encrypted = $3, verify_token = $4,
                         webhook_url = $5, updated_at = NOW()
                     WHERE account_id = $6`,
                    [phone_number_id.trim(), business_account_id.trim(),
                     tokenEncrypted, verify_token.trim(),
                     resolvedWebhook, id]
                );
            } else {
                const settingsId = crypto.randomUUID();
                await DatabaseManager.systemDB.run(
                    `INSERT INTO whatsapp_business_settings
                     (id, account_id, phone_number_id, business_account_id,
                      access_token_encrypted, verify_token, webhook_url)
                     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                    [settingsId, id, phone_number_id.trim(), business_account_id.trim(),
                     tokenEncrypted, verify_token.trim(), resolvedWebhook]
                );
            }

            // تحديث نوع الاتصال في جدول الحسابات
            await DatabaseManager.systemDB.run(
                `UPDATE accounts SET connection_type = 'business_api', updated_at = NOW() WHERE id = $1`, [id]
            );

            return res.json({
                success: true,
                message: 'تم حفظ إعدادات Business API بنجاح',
                webhook_url: resolvedWebhook,
            });
        } catch (err) {
            console.error('[BusinessAPI] saveSettings error:', err);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── اختبار اتصال Business API ─────────────────────────────────────────────
    async testConnection(req, res) {
        try {
            const { id } = req.params;
            const row = await DatabaseManager.systemDB.get(
                `SELECT * FROM whatsapp_business_settings WHERE account_id = $1`, [id]
            );
            if (!row) return res.status(404).json({ success: false, error: 'لم يتم إعداد Business API بعد' });

            const token = decryptToken(row.access_token_encrypted);
            if (!token) return res.status(400).json({ success: false, error: 'Access Token غير موجود' });

            // اختبار بـ Graph API
            const testUrl = `https://graph.facebook.com/v18.0/${row.phone_number_id}?fields=id,display_phone_number,verified_name`;
            const response = await fetch(testUrl, {
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10000),
            });
            const data = await response.json();

            if (response.ok && data.id) {
                await DatabaseManager.systemDB.run(
                    `UPDATE whatsapp_business_settings SET last_tested_at = NOW(), is_verified = TRUE WHERE account_id = $1`, [id]
                );
                await DatabaseManager.systemDB.run(
                    `UPDATE accounts SET status = 'connected', updated_at = NOW() WHERE id = $1`, [id]
                );
                return res.json({
                    success: true,
                    message: 'الاتصال ناجح ✓',
                    phone_number: data.display_phone_number,
                    verified_name: data.verified_name,
                });
            } else {
                return res.json({
                    success: false,
                    error: data.error?.message || 'فشل التحقق من صحة بيانات API',
                });
            }
        } catch (err) {
            console.error('[BusinessAPI] testConnection error:', err);
            return res.status(500).json({ success: false, error: 'فشل الاتصال بـ Graph API: ' + err.message });
        }
    }

    // ── إرسال رسالة نصية عبر Cloud API ─────────────────────────────────────
    async sendMessage(req, res) {
        try {
            const { id } = req.params;
            const { to, message, type = 'text' } = req.body;

            if (!to || !message) return res.status(400).json({ success: false, error: 'to و message مطلوبان' });

            const row = await DatabaseManager.systemDB.get(
                `SELECT * FROM whatsapp_business_settings WHERE account_id = $1`, [id]
            );
            if (!row) return res.status(404).json({ success: false, error: 'Business API غير مُعَد' });

            const token = decryptToken(row.access_token_encrypted);
            const payload = {
                messaging_product: 'whatsapp',
                to: to.replace(/\D/g, ''),
                type: 'text',
                text: { body: message }
            };

            const response = await fetch(
                `https://graph.facebook.com/v18.0/${row.phone_number_id}/messages`,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(payload),
                    signal: AbortSignal.timeout(15000),
                }
            );
            const data = await response.json();

            if (response.ok) {
                return res.json({ success: true, message_id: data.messages?.[0]?.id });
            } else {
                return res.status(400).json({ success: false, error: data.error?.message || 'فشل الإرسال' });
            }
        } catch (err) {
            console.error('[BusinessAPI] sendMessage error:', err);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── Webhook Verification (GET) — التحقق من Webhook مع Meta ─────────────
    async webhookVerify(req, res) {
        try {
            const { accountId } = req.params;
            const mode      = req.query['hub.mode'];
            const token     = req.query['hub.verify_token'];
            const challenge = req.query['hub.challenge'];

            const row = await DatabaseManager.systemDB.get(
                `SELECT verify_token FROM whatsapp_business_settings WHERE account_id = $1`, [accountId]
            );

            if (mode === 'subscribe' && row && token === row.verify_token) {
                await DatabaseManager.systemDB.run(
                    `UPDATE whatsapp_business_settings SET is_verified = TRUE WHERE account_id = $1`, [accountId]
                );
                return res.status(200).send(challenge);
            }
            return res.sendStatus(403);
        } catch (err) {
            console.error('[BusinessAPI] webhookVerify error:', err);
            return res.sendStatus(500);
        }
    }

    // ── Webhook Handler (POST) — استقبال الرسائل الواردة ─────────────────────
    async webhookReceive(req, res) {
        try {
            // Meta يتوقع 200 فوري
            res.sendStatus(200);

            const { accountId } = req.params;
            const body = req.body;

            if (body.object !== 'whatsapp_business_account') return;

            for (const entry of (body.entry || [])) {
                for (const change of (entry.changes || [])) {
                    if (change.field !== 'messages') continue;
                    const value = change.value;

                    // رسائل واردة
                    for (const msg of (value.messages || [])) {
                        const from    = msg.from;
                        const msgType = msg.type;
                        const text    = msg.text?.body || '';
                        const ts      = new Date(parseInt(msg.timestamp) * 1000);

                        console.log(`[BusinessAPI][${accountId}] Message from ${from}: ${text} (${msgType})`);

                        // يمكن تخزين الرسائل في AccountDB هنا
                        try {
                            const adb = await DatabaseManager.getAccountDB(accountId);
                            await adb.run(
                                `INSERT INTO incoming_messages
                                 (id, from_number, message_type, body, timestamp)
                                 VALUES ($1, $2, $3, $4, $5)
                                 ON CONFLICT DO NOTHING`,
                                [msg.id, from, msgType, text, ts]
                            ).catch(() => {}); // الجدول قد لا يكون موجوداً — تجاهل
                        } catch {}
                    }

                    // حالات القراءة والتسليم
                    for (const status of (value.statuses || [])) {
                        console.log(`[BusinessAPI][${accountId}] Status: ${status.status} for ${status.id}`);
                    }
                }
            }
        } catch (err) {
            console.error('[BusinessAPI] webhookReceive error:', err);
        }
    }
}

module.exports = new BusinessAPIController();
