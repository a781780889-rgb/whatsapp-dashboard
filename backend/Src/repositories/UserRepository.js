'use strict';
/**
 * UserRepository — منطق الوصول للبيانات الخاص بالمستخدمين
 * المرحلة 8: Code Quality — FIX-27: Repository Pattern
 *
 * يُغلّف جميع استعلامات جدول users عن UserController / AuthController.
 */
const BaseRepository = require('./BaseRepository');

class UserRepository extends BaseRepository {
    /**
     * @param {object} systemDB  — مرجع SystemDB
     */
    constructor(systemDB) {
        super(systemDB, 'users');
        this.systemDB = systemDB;
    }

    // ── البحث ─────────────────────────────────────────────────────────────────

    /**
     * إيجاد مستخدم بالـ username (حساسية الحالة مهملة)
     */
    async findByUsername(username) {
        return this.systemDB.get(
            `SELECT * FROM users WHERE LOWER(username) = LOWER($1)`,
            [username]
        );
    }

    /**
     * إيجاد مستخدم نشط بالـ username (غير معلّق)
     */
    async findActiveByUsername(username) {
        return this.systemDB.get(
            `SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND status != 'suspended'`,
            [username]
        );
    }

    /**
     * إيجاد مستخدم بالـ ID مع عدد حساباته
     */
    async findByIdWithStats(id) {
        return this.systemDB.get(
            `SELECT u.*,
                    COUNT(a.id)::int AS account_count
             FROM users u
             LEFT JOIN accounts a ON a.user_id = u.id
             WHERE u.id = $1
             GROUP BY u.id`,
            [id]
        );
    }

    /**
     * قائمة المستخدمين مع Pagination + فلتر اختياري
     */
    async listUsers(query = {}, filter = {}) {
        const { page, limit, offset } = this._parsePagination(query);

        // بناء شرط ديناميكي
        const conditions = [];
        const params     = [];

        if (filter.role && filter.role !== 'all') {
            params.push(filter.role);
            conditions.push(`u.role = $${params.length}`);
        }
        if (filter.status && filter.status !== 'all') {
            params.push(filter.status);
            conditions.push(`u.status = $${params.length}`);
        }
        if (filter.search) {
            params.push(`%${filter.search}%`);
            conditions.push(`(u.username ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

        params.push(limit);
        params.push(offset);

        const [rows, countRow] = await Promise.all([
            this.systemDB.all(
                `SELECT u.id, u.username, u.email, u.role, u.status,
                        u.created_at, u.last_login,
                        COUNT(a.id)::int AS account_count
                 FROM users u
                 LEFT JOIN accounts a ON a.user_id = u.id
                 ${where}
                 GROUP BY u.id
                 ORDER BY u.created_at DESC
                 LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            ),
            this.systemDB.get(
                `SELECT COUNT(*)::int AS count FROM users u ${where}`,
                params.slice(0, -2)
            ),
        ]);

        return { rows, total: countRow?.count ?? 0, page, limit };
    }

    // ── الكتابة ────────────────────────────────────────────────────────────────

    /**
     * إنشاء مستخدم جديد
     */
    async createUser({ id, username, passwordHash, email, role, subscriptionPlan, subscriptionExpiry }) {
        return this.systemDB.get(
            `INSERT INTO users (id, username, password, email, role, status,
                                subscription_plan, subscription_expiry, created_at)
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $7, NOW())
             RETURNING id, username, email, role, status`,
            [id, username, passwordHash, email ?? null, role ?? 'user',
             subscriptionPlan ?? 'basic', subscriptionExpiry ?? null]
        );
    }

    /**
     * تحديث آخر تسجيل دخول
     */
    async touchLastLogin(userId, ip) {
        await this.systemDB.run(
            `UPDATE users SET last_login = NOW(), last_login_ip = $1,
                              failed_login_count = 0, locked_until = NULL
             WHERE id = $2`,
            [ip, userId]
        );
    }

    /**
     * تسجيل فشل تسجيل الدخول
     */
    async recordFailedLogin(userId, ip) {
        await this.systemDB.run(
            `UPDATE users
             SET failed_login_count = COALESCE(failed_login_count, 0) + 1,
                 last_failed_login  = NOW(),
                 locked_until       = CASE
                     WHEN COALESCE(failed_login_count, 0) + 1 >= 5
                     THEN NOW() + INTERVAL '15 minutes'
                     ELSE NULL
                 END
             WHERE id = $1`,
            [userId]
        );
    }

    /**
     * إعادة تعيين عداد الفشل
     */
    async resetFailedLogin(userId) {
        await this.systemDB.run(
            `UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`,
            [userId]
        );
    }

    /**
     * تحديث كلمة المرور
     */
    async updatePassword(userId, newHash) {
        await this.systemDB.run(
            `UPDATE users SET password = $1, password_changed_at = NOW() WHERE id = $2`,
            [newHash, userId]
        );
    }

    /**
     * تحديث الحالة (active / suspended)
     */
    async updateStatus(userId, status) {
        await this.systemDB.run(
            `UPDATE users SET status = $1 WHERE id = $2`,
            [status, userId]
        );
    }

    /**
     * تفعيل / إيقاف MFA
     */
    async setMFA(userId, secret, enabled) {
        await this.systemDB.run(
            `UPDATE users SET mfa_secret = $1, mfa_enabled = $2 WHERE id = $3`,
            [secret, enabled, userId]
        );
    }

    /**
     * حذف مستخدم
     */
    async deleteUser(userId) {
        await this.systemDB.run('DELETE FROM users WHERE id = $1', [userId]);
    }

    // ── التحقق ────────────────────────────────────────────────────────────────

    /**
     * هل الـ username مستخدم بالفعل؟
     */
    async usernameExists(username, excludeId = null) {
        const params = [username];
        let sql = 'SELECT id FROM users WHERE LOWER(username) = LOWER($1)';
        if (excludeId) {
            params.push(excludeId);
            sql += ' AND id != $2';
        }
        const row = await this.systemDB.get(sql, params);
        return !!row;
    }
}

module.exports = UserRepository;
