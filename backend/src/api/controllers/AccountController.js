'use strict';
const DatabaseManager   = require('../../database/DatabaseManager');
const WhatsAppManager   = require('../../bot/WhatsAppManager');
const AccountRoleEngine = require('../services/AccountRoleEngine');
const crypto = require('crypto');

const VALID_ROLES = ['publisher', 'searcher', 'joiner', 'monitor', 'stopped'];

class AccountController {

    async createAccount(req, res) {
        try {
            const { name, phone_number, user_id } = req.body;
            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'اسم الحساب مطلوب' });
            }
            const id = crypto.randomUUID();
            await DatabaseManager.systemDB.run(
                `INSERT INTO accounts (id, user_id, phone_number, name, role, task_status)
                 VALUES ($1, $2, $3, $4, 'stopped', 'idle')`,
                [id, user_id || null, phone_number || null, name.trim()]
            );
            await DatabaseManager.getAccountDB(id);
            return res.status(201).json({
                success: true, message: 'Account created successfully', accountId: id,
                account: { id, name: name.trim(), phone_number: phone_number || null,
                    user_id: user_id || null, status: 'disconnected', role: 'stopped', task_status: 'idle' }
            });
        } catch (error) {
            console.error('Create Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async listAccounts(req, res) {
        try {
            const accounts = await DatabaseManager.systemDB.all(`
                SELECT id, name, phone_number, status, health_status,
                       role, task_status, last_activity_at,
                       messages_sent_today, created_at, updated_at
                FROM accounts ORDER BY created_at DESC
            `);
            return res.json({ success: true, accounts });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getAccountDetails(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT * FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            return res.json({ success: true, account });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getAccountStats(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT * FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            const accountDB = await DatabaseManager.getAccountDB(id);
            const [groupsRow, adsRow, msgsRow, schedulesRow, linksRow] = await Promise.all([
                accountDB.get(`SELECT COUNT(*) as cnt FROM groups`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM ad_library WHERE is_active = TRUE`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM messages`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM broadcast_schedules WHERE status = 'active'`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM extracted_links`),
            ]);
            return res.json({
                success: true, stats: {
                    groups: parseInt(groupsRow?.cnt || 0), activeAds: parseInt(adsRow?.cnt || 0),
                    messagesSent: parseInt(msgsRow?.cnt || 0), activeSchedules: parseInt(schedulesRow?.cnt || 0),
                    extractedLinks: parseInt(linksRow?.cnt || 0), role: account.role,
                    taskStatus: account.task_status, lastActivity: account.last_activity_at,
                    healthStatus: account.health_status,
                }
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getSummary(req, res) {
        try {
            const summary = await AccountRoleEngine.getSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async updateRole(req, res) {
        try {
            const { id } = req.params;
            const { role } = req.body;
            if (!VALID_ROLES.includes(role)) {
                return res.status(400).json({ success: false, error: `دور غير صالح. الأدوار: ${VALID_ROLES.join(', ')}` });
            }
            const account = await DatabaseManager.systemDB.get(`SELECT id FROM accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            await AccountRoleEngine.setAccountRole(id, role);
            if (role === 'stopped') await AccountRoleEngine.stopAccount(id);
            return res.json({ success: true, message: `تم تغيير دور الحساب إلى: ${role}`, role });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async startTasks(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id, role, status FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            if (account.status !== 'connected') {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب.' });
            }
            if (account.role === 'stopped') {
                return res.status(400).json({ success: false, error: 'يرجى تحديد دور للحساب.' });
            }
            await AccountRoleEngine.startAccount(id);
            return res.json({ success: true, message: `تم تشغيل مهام الحساب (دور: ${account.role})` });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async stopTasks(req, res) {
        try {
            const { id } = req.params;
            await AccountRoleEngine.stopAccount(id);
            return res.json({ success: true, message: 'تم إيقاف مهام الحساب' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async restartTasks(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id, role, status FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            await AccountRoleEngine.stopAccount(id);
            await new Promise(r => setTimeout(r, 1000));
            if (account.status === 'connected' && account.role !== 'stopped') {
                await AccountRoleEngine.startAccount(id);
            }
            return res.json({ success: true, message: 'تمت إعادة تشغيل المهام' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async testConnection(req, res) {
        try {
            const { id } = req.params;
            const session   = WhatsAppManager.getSession(id);
            const isConnected = session?.user?.id ? true : false;
            const account   = await DatabaseManager.systemDB.get(
                `SELECT name, status, health_status FROM accounts WHERE id = $1`, [id]
            );
            return res.json({
                success: true, connected: isConnected,
                sessionUser: session?.user?.id || null,
                dbStatus: account?.status, healthStatus: account?.health_status,
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getLogs(req, res) {
        try {
            const { id }   = req.params;
            const limit    = parseInt(req.query.limit || '50', 10);
            const accountDB = await DatabaseManager.getAccountDB(id);
            const [campaignLogs, scheduleLogs] = await Promise.all([
                accountDB.all(`SELECT 'campaign' as source, level, message, created_at FROM campaign_logs ORDER BY created_at DESC LIMIT $1`, [Math.floor(limit / 2)]),
                accountDB.all(`SELECT 'schedule' as source, level, message, created_at FROM schedule_logs ORDER BY created_at DESC LIMIT $1`, [Math.floor(limit / 2)]),
            ]);
            const logs = [...campaignLogs, ...scheduleLogs]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, limit);
            return res.json({ success: true, logs });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── ربط الحساب بـ QR Code ─────────────────────────────────────────────────
    async connectAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            await DatabaseManager.systemDB.run(
                `UPDATE accounts SET connection_type = 'qr_code' WHERE id = $1`, [id]
            );

            WhatsAppManager.initSession(id).catch(err =>
                console.error(`[Account ${id}] initSession error:`, err.message)
            );

            return res.json({ success: true, message: 'جارٍ إنشاء QR Code، سيظهر خلال ثوانٍ...' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── حالة QR الحالية (للـ Polling من Frontend) ────────────────────────────
    async getQrStatus(req, res) {
        try {
            const { id } = req.params;
            const { state, qr, ts } = WhatsAppManager.getQrStatus(id);
            return res.json({ success: true, state, qr, ts });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── ربط الحساب بـ Pairing Code ───────────────────────────────────────────
    async connectWithPairing(req, res) {
        try {
            const { id } = req.params;
            const { phone_number } = req.body;

            if (!phone_number) {
                return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
            }

            const cleanPhone = phone_number.replace(/\D/g, '');
            if (cleanPhone.length < 10 || cleanPhone.length > 15) {
                return res.status(400).json({ success: false, error: 'رقم الهاتف غير صحيح (10-15 رقماً)' });
            }

            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            await DatabaseManager.systemDB.run(
                `UPDATE accounts SET connection_type = 'pairing_code', phone_number = $1 WHERE id = $2`,
                [cleanPhone, id]
            );

            // تشغيل جلسة Pairing في الخلفية
            WhatsAppManager.initPairingSession(id, cleanPhone).catch(err =>
                console.error(`[Account ${id}] initPairingSession error:`, err.message)
            );

            return res.json({
                success: true,
                message: 'جارٍ إنشاء Pairing Code، سيظهر خلال ثوانٍ...',
            });
        } catch (error) {
            console.error('Connect Pairing Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async disconnectAccount(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (session) { try { await session.logout(); } catch (_) {} }
            await DatabaseManager.systemDB.run(
                `UPDATE accounts SET status = 'disconnected', task_status = 'idle' WHERE id = $1`, [id]
            );
            return res.json({ success: true, message: 'Account disconnected.' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async resetSession(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(`SELECT id FROM accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            await WhatsAppManager.forceResetSession(id);
            return res.json({ success: true, message: 'تم مسح الجلسة. انتظر رمز QR الجديد.' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (session) { try { await session.logout(); } catch (_) {} }
            await DatabaseManager.closeAccountDB(id);
            await DatabaseManager.systemDB.run(`DELETE FROM accounts WHERE id = $1`, [id]);
            return res.json({ success: true, message: 'Account deleted completely.' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new AccountController();
