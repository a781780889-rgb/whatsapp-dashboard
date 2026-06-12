'use strict';
/**
 * AccountRepository — منطق الوصول للبيانات الخاص بالحسابات
 * المرحلة 8: Code Quality — FIX-27: Repository Pattern
 *
 * يفصل استعلامات DB عن AccountController تماماً.
 * الـ Controller يستدعي هذا الـ Repository ولا يكتب SQL أبداً.
 */
const BaseRepository = require('./BaseRepository');
const CacheService   = require('../lib/CacheService');

class AccountRepository extends BaseRepository {
    /**
     * @param {object} systemDB  — مرجع SystemDB
     */
    constructor(systemDB) {
        super(systemDB, 'accounts');
        this.systemDB = systemDB;
    }

    // ── القراءة ────────────────────────────────────────────────────────────────

    /**
     * قائمة الحسابات (Admin — كل الحسابات) مع Pagination
     */
    async listAll(query = {}) {
        const { page, limit, offset } = this._parsePagination(query);

        // Cache
        const cacheKey = `accounts:admin:p${page}:l${limit}`;
        const cached = await CacheService.get(cacheKey);
        if (cached) return { ...cached, fromCache: true };

        const [rows, total] = await Promise.all([
            this.systemDB.all(
                `SELECT a.id, a.name, a.phone_number, a.role, a.task_status,
                        a.created_at, a.warmup_phase, a.user_id,
                        u.username AS owner_username
                 FROM accounts a
                 LEFT JOIN users u ON u.id = a.user_id
                 ORDER BY a.created_at DESC
                 LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            this.systemDB.get('SELECT COUNT(*)::int AS count FROM accounts'),
        ]);

        const result = { rows, total: total?.count ?? 0, page, limit };
        await CacheService.set(cacheKey, result, 30);
        return result;
    }

    /**
     * قائمة حسابات مستخدم محدد مع Pagination
     * @param {string} userId
     */
    async listByUser(userId, query = {}) {
        const { page, limit, offset } = this._parsePagination(query);

        const cacheKey = `accounts:user:${userId}:p${page}:l${limit}`;
        const cached = await CacheService.get(cacheKey);
        if (cached) return { ...cached, fromCache: true };

        const [rows, total] = await Promise.all([
            this.systemDB.all(
                `SELECT id, name, phone_number, role, task_status, created_at, warmup_phase
                 FROM accounts
                 WHERE user_id = $1
                 ORDER BY created_at DESC
                 LIMIT $2 OFFSET $3`,
                [userId, limit, offset]
            ),
            this.systemDB.get(
                'SELECT COUNT(*)::int AS count FROM accounts WHERE user_id = $1',
                [userId]
            ),
        ]);

        const result = { rows, total: total?.count ?? 0, page, limit };
        await CacheService.set(cacheKey, result, 30);
        return result;
    }

    /**
     * إيجاد حساب بالـ ID مع اسم المالك
     */
    async findByIdWithOwner(id) {
        return this.systemDB.get(
            `SELECT a.*, u.username AS owner_username
             FROM accounts a
             LEFT JOIN users u ON u.id = a.user_id
             WHERE a.id = $1`,
            [id]
        );
    }

    /**
     * إيجاد حساب بالرقم مع فحص تكرار اختياري
     */
    async findByPhone(phone, excludeId = null) {
        if (excludeId) {
            return this.systemDB.get(
                'SELECT id FROM accounts WHERE phone_number = $1 AND id != $2',
                [phone, excludeId]
            );
        }
        return this.systemDB.get(
            'SELECT id FROM accounts WHERE phone_number = $1',
            [phone]
        );
    }

    // ── الكتابة ────────────────────────────────────────────────────────────────

    /**
     * إنشاء حساب جديد
     */
    async createAccount({ id, userId, phoneNumber, name }) {
        await this.systemDB.run(
            `INSERT INTO accounts (id, user_id, phone_number, name, role, task_status, warmup_phase, warmup_started_at)
             VALUES ($1, $2, $3, $4, 'stopped', 'idle', TRUE, NOW())`,
            [id, userId ?? null, phoneNumber ?? null, name.trim()]
        );
        await this._invalidateCache(userId);
        return { id, name: name.trim(), phone_number: phoneNumber ?? null,
            user_id: userId ?? null, status: 'disconnected', role: 'stopped', task_status: 'idle' };
    }

    /**
     * تحديث اسم الحساب
     */
    async updateName(id, name, userId) {
        await this.systemDB.run(
            'UPDATE accounts SET name = $1 WHERE id = $2',
            [name.trim(), id]
        );
        await this._invalidateCache(userId);
    }

    /**
     * تحديث رقم الهاتف
     */
    async updatePhone(id, phone, userId) {
        await this.systemDB.run(
            'UPDATE accounts SET phone_number = $1 WHERE id = $2',
            [phone, id]
        );
        await this._invalidateCache(userId);
    }

    /**
     * تحديث دور الحساب
     */
    async updateRole(id, role, userId) {
        await this.systemDB.run(
            'UPDATE accounts SET role = $1 WHERE id = $2',
            [role, id]
        );
        await this._invalidateCache(userId);
    }

    /**
     * حذف حساب
     */
    async deleteAccount(id, userId) {
        await this.systemDB.run('DELETE FROM accounts WHERE id = $1', [id]);
        await this._invalidateCache(userId);
    }

    /**
     * ربط حساب بمستخدم
     */
    async assignToUser(accountId, userId) {
        await this.systemDB.run(
            'UPDATE accounts SET user_id = $1 WHERE id = $2',
            [userId, accountId]
        );
        await this._invalidateCache(userId);
    }

    // ── التحقق من الملكية ─────────────────────────────────────────────────────

    /**
     * هل الحساب ملك للمستخدم؟
     */
    async belongsToUser(accountId, userId) {
        const row = await this.systemDB.get(
            'SELECT id FROM accounts WHERE id = $1 AND user_id = $2',
            [accountId, userId]
        );
        return !!row;
    }

    // ── Cache Helpers ──────────────────────────────────────────────────────────

    async _invalidateCache(userId) {
        await CacheService.invalidateAccountsList();
        if (userId) {
            await CacheService.invalidatePattern?.(`accounts:user:${userId}:*`);
        }
    }
}

module.exports = AccountRepository;
