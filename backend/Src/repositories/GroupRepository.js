'use strict';
/**
 * GroupRepository — منطق الوصول للبيانات الخاص بالمجموعات
 * المرحلة 8: Code Quality — FIX-27: Repository Pattern
 *
 * يُغلّف استعلامات AccountDB (per-tenant) الخاصة بالمجموعات
 * ويُخفّف GroupController من SQL مباشر.
 */
const BaseRepository = require('./BaseRepository');
const CacheService   = require('../lib/CacheService');

class GroupRepository extends BaseRepository {
    /**
     * @param {object} accountDB  — مرجع AccountDB الخاص بالحساب
     * @param {string} accountId  — معرّف الحساب (للـ cache)
     */
    constructor(accountDB, accountId) {
        super(accountDB, 'groups');
        this.accountDB = accountDB;
        this.accountId = accountId;
    }

    // ── القراءة ────────────────────────────────────────────────────────────────

    /**
     * قائمة المجموعات مع Pagination + فلتر
     * @param {object} query   — { page, limit, search, filter }
     */
    async listGroups(query = {}) {
        const { page, limit, offset } = this._parsePagination(query);

        // بناء WHERE
        const conditions = [];
        const params     = [];

        if (query.search) {
            params.push(`%${query.search}%`);
            conditions.push(`(name ILIKE $${params.length} OR group_jid ILIKE $${params.length})`);
        }
        if (query.filter === 'active') {
            conditions.push(`status = 'active'`);
        } else if (query.filter === 'left') {
            conditions.push(`status = 'left'`);
        }

        const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
        params.push(limit, offset);

        const [rows, countRow] = await Promise.all([
            this.accountDB.all(
                `SELECT id, name, group_jid, status, member_count,
                        description, created_at, last_synced_at
                 FROM groups
                 ${where}
                 ORDER BY name ASC
                 LIMIT $${params.length - 1} OFFSET $${params.length}`,
                params
            ),
            this.accountDB.get(
                `SELECT COUNT(*)::int AS count FROM groups ${where}`,
                params.slice(0, -2)
            ),
        ]);

        return { rows, total: countRow?.count ?? 0, page, limit };
    }

    /**
     * إيجاد مجموعة بالـ JID
     */
    async findByJid(jid) {
        return this.accountDB.get(
            'SELECT * FROM groups WHERE group_jid = $1',
            [jid]
        );
    }

    /**
     * إحصاءات المجموعات للحساب
     */
    async getStats() {
        const cacheKey = `groups:stats:${this.accountId}`;
        const cached = await CacheService.get(cacheKey);
        if (cached) return cached;

        const row = await this.accountDB.get(
            `SELECT
                COUNT(*)::int                             AS total,
                COUNT(*) FILTER (WHERE status='active')::int  AS active,
                COUNT(*) FILTER (WHERE status='left')::int    AS left_count,
                COALESCE(SUM(member_count), 0)::int       AS total_members,
                MAX(last_synced_at)                       AS last_sync
             FROM groups`
        );

        await CacheService.set(cacheKey, row, 60);
        return row;
    }

    // ── Upsert Batch ───────────────────────────────────────────────────────────

    /**
     * Upsert دفعة من المجموعات (N+1 fix)
     * يقسّم إلى chunks لتجنب تجاوز حد المعاملات
     *
     * @param {Array<{jid,name,subject,memberCount}>} groups
     * @param {number} chunkSize
     */
    async upsertBatch(groups, chunkSize = 50) {
        if (!groups?.length) return 0;

        let upserted = 0;

        for (let i = 0; i < groups.length; i += chunkSize) {
            const chunk = groups.slice(i, i + chunkSize);
            const vals  = [];
            const placeholders = chunk.map((g, j) => {
                const base = j * 4;
                vals.push(
                    g.jid,
                    g.name || g.subject || 'Unknown',
                    g.memberCount ?? 0,
                    'active'
                );
                return `($${base+1}, $${base+2}, $${base+3}, $${base+4}, NOW())`;
            }).join(', ');

            await this.accountDB.run(
                `INSERT INTO groups (group_jid, name, member_count, status, last_synced_at)
                 VALUES ${placeholders}
                 ON CONFLICT (group_jid) DO UPDATE SET
                     name           = EXCLUDED.name,
                     member_count   = EXCLUDED.member_count,
                     status         = EXCLUDED.status,
                     last_synced_at = NOW()`,
                vals
            );
            upserted += chunk.length;
        }

        // مسح الـ cache بعد التحديث
        await CacheService.invalidate?.(`groups:stats:${this.accountId}`);
        return upserted;
    }

    /**
     * تحديث حالة مجموعة
     */
    async updateStatus(jid, status) {
        await this.accountDB.run(
            'UPDATE groups SET status = $1 WHERE group_jid = $2',
            [status, jid]
        );
    }

    /**
     * حذف مجموعة من القائمة
     */
    async removeByJid(jid) {
        await this.accountDB.run(
            'DELETE FROM groups WHERE group_jid = $1',
            [jid]
        );
        await CacheService.invalidate?.(`groups:stats:${this.accountId}`);
    }
}

module.exports = GroupRepository;
