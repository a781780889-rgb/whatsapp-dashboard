'use strict';
/**
 * BaseRepository — القاعدة المشتركة لجميع Repositories
 * المرحلة 8: Code Quality — FIX-27: Repository Pattern
 *
 * يوفر:
 *   - CRUD خفيف مبني على اسم الجدول
 *   - دعم Pagination موحّد
 *   - Helper لبناء WHERE clauses ديناميكية
 */

class BaseRepository {
    /**
     * @param {object} db  — مرجع قاعدة البيانات (SystemDB أو AccountDB)
     * @param {string} table — اسم الجدول
     */
    constructor(db, table) {
        if (!db)    throw new Error('BaseRepository: db is required');
        if (!table) throw new Error('BaseRepository: table is required');
        this.db    = db;
        this.table = table;
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    /**
     * بناء شرط WHERE من كائن { col: val }
     * يُعيد { clause: 'col1=$1 AND col2=$2', params: [v1, v2] }
     */
    _buildWhere(conditions = {}) {
        const entries = Object.entries(conditions).filter(([, v]) => v !== undefined);
        if (!entries.length) return { clause: '1=1', params: [] };
        const clause = entries.map(([col], i) => `${col} = $${i + 1}`).join(' AND ');
        const params = entries.map(([, v]) => v);
        return { clause, params };
    }

    /**
     * تحليل قيم pagination من كائن query string
     */
    _parsePagination(query = {}) {
        const page  = Math.max(1, parseInt(query.page  || '1',  10));
        const limit = Math.min(200, Math.max(1, parseInt(query.limit || '50', 10)));
        const offset = (page - 1) * limit;
        return { page, limit, offset };
    }

    // ── CRUD أساسي ─────────────────────────────────────────────────────────────

    /**
     * إيجاد سجل واحد بالشروط
     * @param {object} conditions
     * @returns {Promise<object|null>}
     */
    async findOne(conditions) {
        const { clause, params } = this._buildWhere(conditions);
        return this.db.get(
            `SELECT * FROM ${this.table} WHERE ${clause} LIMIT 1`,
            params
        );
    }

    /**
     * إيجاد سجل واحد بالـ id
     * @param {string|number} id
     */
    async findById(id) {
        return this.findOne({ id });
    }

    /**
     * إيجاد جميع السجلات المطابقة
     * @param {object} conditions
     * @param {object} opts  — { orderBy, limit, offset }
     */
    async findMany(conditions = {}, opts = {}) {
        const { clause, params } = this._buildWhere(conditions);
        const order  = opts.orderBy ? `ORDER BY ${opts.orderBy}` : '';
        const limit  = opts.limit  ? `LIMIT ${parseInt(opts.limit)}` : '';
        const offset = opts.offset ? `OFFSET ${parseInt(opts.offset)}` : '';
        return this.db.all(
            `SELECT * FROM ${this.table} WHERE ${clause} ${order} ${limit} ${offset}`.trim(),
            params
        );
    }

    /**
     * عدّ السجلات
     * @param {object} conditions
     * @returns {Promise<number>}
     */
    async count(conditions = {}) {
        const { clause, params } = this._buildWhere(conditions);
        const row = await this.db.get(
            `SELECT COUNT(*)::int AS count FROM ${this.table} WHERE ${clause}`,
            params
        );
        return row?.count ?? 0;
    }

    /**
     * إنشاء سجل جديد
     * @param {object} data  — { col: val, ... }
     * @returns {Promise<object>}
     */
    async create(data) {
        const entries = Object.entries(data);
        const cols    = entries.map(([c]) => c).join(', ');
        const placeholders = entries.map((_, i) => `$${i + 1}`).join(', ');
        const vals    = entries.map(([, v]) => v);
        return this.db.get(
            `INSERT INTO ${this.table} (${cols}) VALUES (${placeholders}) RETURNING *`,
            vals
        );
    }

    /**
     * تحديث سجل بالـ id
     * @param {string|number} id
     * @param {object} data
     * @returns {Promise<object>}
     */
    async updateById(id, data) {
        const entries = Object.entries(data);
        if (!entries.length) return this.findById(id);
        const sets = entries.map(([c], i) => `${c} = $${i + 1}`).join(', ');
        const vals = [...entries.map(([, v]) => v), id];
        return this.db.get(
            `UPDATE ${this.table} SET ${sets}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`,
            vals
        );
    }

    /**
     * حذف سجل بالـ id
     * @param {string|number} id
     * @returns {Promise<boolean>}
     */
    async deleteById(id) {
        const result = await this.db.run(
            `DELETE FROM ${this.table} WHERE id = $1`,
            [id]
        );
        return (result?.rowCount ?? 0) > 0;
    }

    /**
     * قائمة مع Pagination
     * @param {object} conditions
     * @param {object} query  — { page, limit }
     * @param {string} orderBy
     * @returns {Promise<{ rows: object[], total: number, page: number, limit: number }>}
     */
    async paginate(conditions = {}, query = {}, orderBy = 'created_at DESC') {
        const { page, limit, offset } = this._parsePagination(query);
        const [rows, total] = await Promise.all([
            this.findMany(conditions, { orderBy, limit, offset }),
            this.count(conditions),
        ]);
        return { rows, total, page, limit, pages: Math.ceil(total / limit) };
    }
}

module.exports = BaseRepository;
