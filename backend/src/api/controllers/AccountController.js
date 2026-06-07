const DatabaseManager = require('../../database/DatabaseManager');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const crypto = require('crypto');

class AccountController {
    async createAccount(req, res) {
        try {
            const { name, phone_number, user_id } = req.body;

            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'اسم الحساب مطلوب' });
            }

            const id = crypto.randomUUID();

            // Register in System DB
            await DatabaseManager.systemDB.run(
                `INSERT INTO accounts (id, user_id, phone_number, name) VALUES ($1, $2, $3, $4)`,
                [id, user_id || null, phone_number || null, name.trim()]
            );

            // Initialize isolated Account DB
            await DatabaseManager.getAccountDB(id);

            // إرجاع كلا الشكلين لضمان التوافق مع الفرونت-إند
            return res.status(201).json({
                success: true,
                message: 'Account created successfully',
                accountId: id,          // للتوافق مع الكود القديم
                account: {              // ← الفرونت-إند يقرأ data.account.id
                    id,
                    name: name.trim(),
                    phone_number: phone_number || null,
                    user_id: user_id || null,
                    status: 'disconnected',
                }
            });
        } catch (error) {
            console.error('Create Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async listAccounts(req, res) {
        try {
            const accounts = await DatabaseManager.systemDB.all(
                `SELECT id, name, phone_number, status, created_at FROM accounts ORDER BY created_at DESC`
            );
            return res.json({ success: true, accounts });
        } catch (error) {
            console.error('List Accounts Error:', error);
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
            console.error('Get Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async connectAccount(req, res) {
        try {
            const { id } = req.params;

            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            // Trigger Baileys connection (non-blocking — QR يُرسَل عبر Socket.IO)
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

    async disconnectAccount(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (session) {
                try { await session.logout(); } catch (_) { /* ignore */ }
            }
            await DatabaseManager.systemDB.run(
                `UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [id]
            );
            return res.json({ success: true, message: 'Account disconnected.' });
        } catch (error) {
            console.error('Disconnect Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async resetSession(req, res) {
        try {
            const { id } = req.params;

            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            // مسح الجلسة القديمة وبدء QR جديد
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

    async deleteAccount(req, res) {
        try {
            const { id } = req.params;

            // Close WhatsApp session if active
            const session = WhatsAppManager.getSession(id);
            if (session) {
                try { await session.logout(); } catch (_) { /* ignore */ }
            }

            // Close Account DB connection
            await DatabaseManager.closeAccountDB(id);

            // Remove from System DB
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
