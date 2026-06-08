'use strict';
const DatabaseManager  = require('../../database/DatabaseManager');
const WhatsAppManager  = require('../../bot/WhatsAppManager');
const AccountRoleEngine = require('../services/AccountRoleEngine');
const crypto = require('crypto');

const VALID_ROLES = ['publisher', 'searcher', 'joiner', 'monitor', 'stopped'];

class AccountController {

    // ── إنشاء حساب ──────────────────────────────────────────────────────────
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
                success: true,
                message: 'Account created successfully',
                accountId: id,
                account: {
                    id,
                    name: name.trim(),
                    phone_number: phone_number || null,
                    user_id: user_id || null,
                    status: 'disconnected',
                    role: 'stopped',
                    task_status: 'idle',
                }
            });
        } catch (error) {
            console.error('Create Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── قائمة الحسابات مع كامل البيانات ──────────────────────────────────────
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
            console.error('List Accounts Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── تفاصيل حساب واحد ─────────────────────────────────────────────────────
    async getAccountDetails(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT * FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            return res.json({ success: true, account });
        } catch (error) {
            console.error('Get Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── إحصائيات الحساب (مجموعات، إعلانات، رسائل) ─────────────────────────
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
                success: true,
                stats: {
                    groups:          parseInt(groupsRow?.cnt || 0),
                    activeAds:       parseInt(adsRow?.cnt || 0),
                    messagesSent:    parseInt(msgsRow?.cnt || 0),
                    activeSchedules: parseInt(schedulesRow?.cnt || 0),
                    extractedLinks:  parseInt(linksRow?.cnt || 0),
                    role:            account.role,
                    taskStatus:      account.task_status,
                    lastActivity:    account.last_activity_at,
                    healthStatus:    account.health_status,
                }
            });
        } catch (error) {
            console.error('Get Account Stats Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── ملخص أدوار جميع الحسابات ─────────────────────────────────────────────
    async getSummary(req, res) {
        try {
            const summary = await AccountRoleEngine.getSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            console.error('Get Summary Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── تحديث دور الحساب ─────────────────────────────────────────────────────
    async updateRole(req, res) {
        try {
            const { id } = req.params;
            const { role } = req.body;

            if (!VALID_ROLES.includes(role)) {
                return res.status(400).json({
                    success: false,
                    error: `دور غير صالح. الأدوار المتاحة: ${VALID_ROLES.join(', ')}`
                });
            }

            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            await AccountRoleEngine.setAccountRole(id, role);

            // إذا كان الدور 'stopped' → أوقف المهام
            if (role === 'stopped') {
                await AccountRoleEngine.stopAccount(id);
            }

            return res.json({
                success: true,
                message: `تم تغيير دور الحساب إلى: ${role}`,
                role
            });
        } catch (error) {
            console.error('Update Role Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── تشغيل مهام الحساب ─────────────────────────────────────────────────────
    async startTasks(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id, role, status FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            if (account.status !== 'connected') {
                return res.status(400).json({
                    success: false,
                    error: 'الحساب غير متصل بواتساب. يرجى ربط الحساب أولاً.'
                });
            }

            if (account.role === 'stopped') {
                return res.status(400).json({
                    success: false,
                    error: 'يرجى تحديد دور للحساب قبل تشغيل المهام.'
                });
            }

            await AccountRoleEngine.startAccount(id);

            return res.json({
                success: true,
                message: `تم تشغيل مهام الحساب (دور: ${account.role})`
            });
        } catch (error) {
            console.error('Start Tasks Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── إيقاف مهام الحساب ────────────────────────────────────────────────────
    async stopTasks(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            await AccountRoleEngine.stopAccount(id);

            return res.json({ success: true, message: 'تم إيقاف مهام الحساب' });
        } catch (error) {
            console.error('Stop Tasks Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── إعادة تشغيل مهام الحساب ──────────────────────────────────────────────
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
            console.error('Restart Tasks Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── اختبار الاتصال ────────────────────────────────────────────────────────
    async testConnection(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            const isConnected = session?.user?.id ? true : false;
            const account = await DatabaseManager.systemDB.get(
                `SELECT name, status, health_status FROM accounts WHERE id = $1`, [id]
            );

            return res.json({
                success: true,
                connected:    isConnected,
                sessionUser:  session?.user?.id || null,
                dbStatus:     account?.status,
                healthStatus: account?.health_status,
            });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── سجلات الحساب ─────────────────────────────────────────────────────────
    async getLogs(req, res) {
        try {
            const { id } = req.params;
            const limit  = parseInt(req.query.limit || '50', 10);

            const accountDB = await DatabaseManager.getAccountDB(id);

            // جمع السجلات من جميع الجداول
            const [campaignLogs, scheduleLogs] = await Promise.all([
                accountDB.all(`
                    SELECT 'campaign' as source, level, message, created_at
                    FROM campaign_logs
                    ORDER BY created_at DESC LIMIT $1
                `, [Math.floor(limit / 2)]),
                accountDB.all(`
                    SELECT 'schedule' as source, level, message, created_at
                    FROM schedule_logs
                    ORDER BY created_at DESC LIMIT $1
                `, [Math.floor(limit / 2)]),
            ]);

            const logs = [...campaignLogs, ...scheduleLogs]
                .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
                .slice(0, limit);

            return res.json({ success: true, logs });
        } catch (error) {
            console.error('Get Logs Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── ربط الحساب بواتساب ────────────────────────────────────────────────────
    async connectAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            WhatsAppManager.initSession(id).catch(err =>
                console.error(`[Account ${id}] initSession error:`, err.message)
            );

            return res.json({
                success: true,
                message: 'Connection sequence started. Please check dashboard for QR.'
            });
        } catch (error) {
            console.error('Connect Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── فصل الحساب ────────────────────────────────────────────────────────────
    async disconnectAccount(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (session) {
                try { await session.logout(); } catch (_) {}
            }
            await DatabaseManager.systemDB.run(
                `UPDATE accounts SET status = 'disconnected', task_status = 'idle' WHERE id = $1`, [id]
            );
            return res.json({ success: true, message: 'Account disconnected.' });
        } catch (error) {
            console.error('Disconnect Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── إعادة تهيئة الجلسة ────────────────────────────────────────────────────
    async resetSession(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            await WhatsAppManager.forceResetSession(id);
            return res.json({
                success: true,
                message: 'تم مسح الجلسة. انتظر رمز QR الجديد في لوحة التحكم.'
            });
        } catch (error) {
            console.error('Reset Session Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── حذف الحساب ────────────────────────────────────────────────────────────
    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (session) {
                try { await session.logout(); } catch (_) {}
            }
            await DatabaseManager.closeAccountDB(id);
            await DatabaseManager.systemDB.run(
                `DELETE FROM accounts WHERE id = $1`, [id]
            );
            return res.json({ success: true, message: 'Account deleted completely.' });
        } catch (error) {
            console.error('Delete Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new AccountController();
