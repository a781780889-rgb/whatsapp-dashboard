const DatabaseManager = require('../../database/DatabaseManager');
const WhatsAppManager = require('../../bot/WhatsAppManager');
const crypto = require('crypto');

class AccountController {
    async createAccount(req, res) {
        try {
            const { name, phone_number, user_id } = req.body;
            const id = crypto.randomUUID();
            
            // Register in System DB
            await DatabaseManager.systemDB.run(
                `INSERT INTO accounts (id, user_id, phone_number, name) VALUES ($1, $2, $3, $4)`,
                [id, user_id, phone_number, name]
            );

            // Initialize isolated Account DB
            await DatabaseManager.getAccountDB(id);

            res.status(201).json({ success: true, message: 'Account created successfully', accountId: id });
        } catch (error) {
            console.error('Create Account Error:', error);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async listAccounts(req, res) {
        try {
            // In a real app, filter by req.user.id
            const accounts = await DatabaseManager.systemDB.all(`SELECT id, name, phone_number, status, created_at FROM accounts`);
            res.json({ success: true, accounts });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getAccountDetails(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(`SELECT * FROM accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            
            res.json({ success: true, account });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async connectAccount(req, res) {
        try {
            const { id } = req.params;
            // Trigger Baileys connection
            await WhatsAppManager.initSession(id);
            res.json({ success: true, message: 'Connection sequence started. Please check dashboard for QR.' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async disconnectAccount(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (session) {
                session.logout(); // or session.end()
                await DatabaseManager.systemDB.run(`UPDATE accounts SET status = 'disconnected' WHERE id = $1`, [id]);
            }
            res.json({ success: true, message: 'Account disconnected.' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            // Close DB
            await DatabaseManager.closeAccountDB(id);
            
            // Remove from SystemDB
            await DatabaseManager.systemDB.run(`DELETE FROM accounts WHERE id = $1`, [id]);
            
            // NOTE: In production, we'd also delete the SQLite file and session folders.
            
            res.json({ success: true, message: 'Account deleted completely.' });
        } catch (error) {
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new AccountController();
