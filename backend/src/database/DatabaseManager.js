'use strict';
/**
 * DatabaseManager — PostgreSQL Edition
 * يُدير تهيئة SystemDB وإنشاء AccountDB Schemas.
 * يُبقي على واجهة activeAccounts المتوافقة مع الكود الموجود.
 */
const SystemDB = require('./SystemDB');
const AccountDB = require('./AccountDB');

class DatabaseManager {
    constructor() {
        this.systemDB = SystemDB;
        this.activeAccounts = new Map(); // accountId → AccountDB instance
    }

    async init() {
        await this.systemDB.init();
        console.log('[DatabaseManager] System database initialized (PostgreSQL).');
    }

    async getAccountDB(accountId) {
        if (this.activeAccounts.has(accountId)) {
            return this.activeAccounts.get(accountId);
        }

        const accountDB = new AccountDB(accountId);
        await accountDB.init();
        this.activeAccounts.set(accountId, accountDB);

        console.log(`[DatabaseManager] Account schema for [${accountId}] initialized.`);
        return accountDB;
    }

    async closeAccountDB(accountId) {
        if (this.activeAccounts.has(accountId)) {
            const db = this.activeAccounts.get(accountId);
            await db.close();
            this.activeAccounts.delete(accountId);
            console.log(`[DatabaseManager] Account [${accountId}] removed from cache.`);
        }
    }

    async closeAll() {
        for (const [accountId, db] of this.activeAccounts.entries()) {
            await db.close();
        }
        this.activeAccounts.clear();
        console.log('[DatabaseManager] All account DB references cleared.');
    }
}

module.exports = new DatabaseManager();
