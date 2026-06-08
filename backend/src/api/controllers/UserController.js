'use strict';
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const SystemDB = require('../../database/SystemDB');

const ALLOWED_ROLES = ['super_admin','admin','moderator','user'];

class UserController {

    _ip(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    }

    /** GET /api/v1/admin/users */
    async list(req, res) {
        try {
            const { search='', role='', status='', page=1, limit=20 } = req.query;
            const offset = (Number(page)-1) * Number(limit);

            let where = 'WHERE 1=1';
            const params = [];
            if (search) {
                params.push(`%${search}%`,`%${search}%`,`%${search}%`);
                const n = params.length;
                where += ` AND (u.username LIKE $${n-2} OR u.full_name LIKE $${n-1} OR u.email LIKE $${n})`;
            }
            if (role) {
                params.push(role);
                where += ` AND u.role=$${params.length}`;
            }
            if (status) {
                params.push(status);
                where += ` AND u.status=$${params.length}`;
            }

            const users = await SystemDB.all(`
                SELECT u.id, u.username, u.full_name, u.email, u.role, u.status,
                       u.last_login, u.created_at,
                       s.plan_type, s.expires_at, s.status as sub_status,
                       l.license_key, l.status as lic_status
                FROM users u
                LEFT JOIN LATERAL (
                    SELECT plan_type, expires_at, status
                    FROM subscriptions
                    WHERE user_id = u.id
                      AND status = 'active'
                      AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY created_at DESC
                    LIMIT 1
                ) s ON TRUE
                LEFT JOIN LATERAL (
                    SELECT license_key, status
                    FROM licenses
                    WHERE user_id = u.id AND status = 'active'
                    ORDER BY created_at DESC
                    LIMIT 1
                ) l ON TRUE
                ${where}
                ORDER BY u.created_at DESC
                LIMIT $1 OFFSET $2`,
                [...params, Number(limit), offset]);

            const countRow = await SystemDB.get(`SELECT COUNT(*) as cnt FROM users u ${where}`, params);

            // Enrich with days_remaining
            const now = Date.now();
            const enriched = users.map(u => {
                let daysRemaining = -1;
                if (u.expires_at) {
                    const ms = new Date(u.expires_at) - now;
                    daysRemaining = Math.max(0, Math.ceil(ms/86400000));
                }
                return { ...u, daysRemaining };
            });

            res.json({ success:true, users: enriched, total: countRow?.cnt||0, page: Number(page), limit: Number(limit) });
        } catch(err) {
            console.error('[UserCtrl] list:', err);
            res.status(500).json({ success:false, error:'خطأ في جلب المستخدمين.' });
        }
    }

    /** GET /api/v1/admin/users/:id */
    async get(req, res) {
        try {
            const user = await SystemDB.get(`
                SELECT id,username,full_name,email,role,status,last_login,created_at,updated_at
                FROM users WHERE id=$1`, [req.params.id]);
            if (!user) return res.status(404).json({ success:false, error:'المستخدم غير موجود.' });

            const subscriptions = await SystemDB.all(
                'SELECT * FROM subscriptions WHERE user_id=$1 ORDER BY created_at DESC', [user.id]);
            const licenses = await SystemDB.all(
                'SELECT * FROM licenses WHERE user_id=$1 ORDER BY issued_at DESC', [user.id]);
            const logs = await SystemDB.all(
                'SELECT * FROM activity_logs WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50', [user.id]);

            res.json({ success:true, user, subscriptions, licenses, logs });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في جلب بيانات المستخدم.' });
        }
    }

    /** POST /api/v1/admin/users */
    async create(req, res) {
        try {
            const { username, password, fullName, email, role='user', planType='trial_24h' } = req.body || {};

            if (!username || !password)
                return res.status(400).json({ success:false, error:'اسم المستخدم وكلمة المرور مطلوبان.' });
            if (!ALLOWED_ROLES.includes(role))
                return res.status(400).json({ success:false, error:'الدور غير صالح.' });
            if (password.length < 6)
                return res.status(400).json({ success:false, error:'كلمة المرور قصيرة جداً.' });

            const exists = await SystemDB.get('SELECT id FROM users WHERE username=$1', [username]);
            if (exists) return res.status(409).json({ success:false, error:'اسم المستخدم مستخدم بالفعل.' });

            const id   = uuidv4();
            const hash = await bcrypt.hash(password, 12);
            await SystemDB.run(`INSERT INTO users (id,username,password,full_name,email,role,status)
                VALUES ($1,$2,$3,$4,$5,$6,'active')`,
                [id, username, hash, fullName||username, email||null, role]);

            // Create subscription
            await this._createSubscription(id, planType, req.user.id);

            // Issue license
            const licKey = SystemDB._generateLicenseKey();
            await SystemDB.run(`INSERT INTO licenses (id,user_id,license_key,status,issued_by)
                VALUES ($1,$2,$3,'active',$4)`, [uuidv4(), id, licKey, req.user.id]);

            await SystemDB.log(req.user.id, req.user.username, 'USER_CREATED',
                `Created: ${username} (${role})`, this._ip(req));

            res.status(201).json({ success:true, message:'تم إنشاء المستخدم بنجاح.', userId: id, licenseKey: licKey });
        } catch(err) {
            console.error('[UserCtrl] create:', err);
            res.status(500).json({ success:false, error:'خطأ في إنشاء المستخدم.' });
        }
    }

    /** PUT /api/v1/admin/users/:id */
    async update(req, res) {
        try {
            const { fullName, email, role, newPassword } = req.body || {};
            const { id } = req.params;

            const user = await SystemDB.get('SELECT * FROM users WHERE id=$1', [id]);
            if (!user) return res.status(404).json({ success:false, error:'المستخدم غير موجود.' });

            // Prevent changing super_admin role unless caller is super_admin
            if (user.role==='super_admin' && req.user.role!=='super_admin')
                return res.status(403).json({ success:false, error:'لا يمكن تعديل Super Admin.' });

            const fields = [], params = [];
            if (fullName !== undefined) { fields.push(`full_name=$${params.push(fullName)}`); }
            if (email    !== undefined) { fields.push(`email=$${params.push(email)}`); }
            if (role && ALLOWED_ROLES.includes(role)) { fields.push(`role=$${params.push(role)}`); }
            if (newPassword && newPassword.length >= 6) {
                fields.push(`password=$${params.push(await bcrypt.hash(newPassword, 12))}`);
            }
            if (fields.length) {
                fields.push('updated_at=NOW()');
                params.push(id);
                await SystemDB.run(`UPDATE users SET ${fields.join(',')} WHERE id=$${params.length}`, params);
            }

            await SystemDB.log(req.user.id, req.user.username, 'USER_UPDATED', `Updated: ${user.username}`, this._ip(req));
            res.json({ success:true, message:'تم تحديث بيانات المستخدم.' });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في تحديث المستخدم.' });
        }
    }

    /** DELETE /api/v1/admin/users/:id */
    async delete(req, res) {
        try {
            const { id } = req.params;
            if (id === req.user.id)
                return res.status(400).json({ success:false, error:'لا يمكنك حذف حسابك الخاص.' });

            const user = await SystemDB.get('SELECT * FROM users WHERE id=$1', [id]);
            if (!user) return res.status(404).json({ success:false, error:'المستخدم غير موجود.' });
            if (user.role==='super_admin')
                return res.status(403).json({ success:false, error:'لا يمكن حذف Super Admin.' });

            await SystemDB.run('DELETE FROM users WHERE id=$1', [id]);
            await SystemDB.log(req.user.id, req.user.username, 'USER_DELETED', `Deleted: ${user.username}`, this._ip(req));
            res.json({ success:true, message:'تم حذف المستخدم.' });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في حذف المستخدم.' });
        }
    }

    /** PATCH /api/v1/admin/users/:id/status */
    async setStatus(req, res) {
        try {
            const { status } = req.body || {};
            const { id } = req.params;
            if (!['active','suspended'].includes(status))
                return res.status(400).json({ success:false, error:'حالة غير صالحة.' });

            const user = await SystemDB.get('SELECT * FROM users WHERE id=$1', [id]);
            if (!user) return res.status(404).json({ success:false, error:'المستخدم غير موجود.' });
            if (user.role==='super_admin')
                return res.status(403).json({ success:false, error:'لا يمكن تغيير حالة Super Admin.' });

            await SystemDB.run('UPDATE users SET status=$1,updated_at=NOW() WHERE id=$2', [status, id]);
            await SystemDB.log(req.user.id, req.user.username,
                status==='suspended' ? 'USER_SUSPENDED' : 'USER_ACTIVATED',
                `${user.username}`, this._ip(req));

            res.json({ success:true, message: status==='suspended' ? 'تم إيقاف المستخدم.' : 'تم تفعيل المستخدم.' });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في تغيير الحالة.' });
        }
    }

    // ── Internal helpers ──────────────────────────────────────────────────────
    async _createSubscription(userId, planType, createdBy) {
        const durations = {
            'trial_24h': 1/24 * 24, // 1 day but labeled as 24h
            '3d':3,'7d':7,'15d':15,'30d':30,'60d':60,'90d':90,'180d':180,'365d':365,
            'lifetime': null
        };
        const actual_durations = {
            'trial_24h': 1/24, // hours
            '3d':3,'7d':7,'15d':15,'30d':30,'60d':60,'90d':90,'180d':180,'365d':365,
            'lifetime': null
        };
        // Override with correct hours
        const hours = {
            'trial_24h': 24,
            '3d':72,'7d':168,'15d':360,'30d':720,'60d':1440,'90d':2160,'180d':4320,'365d':8760,
            'lifetime': null
        };

        const h = hours[planType];
        let expiresAt = null;
        if (h !== null && h !== undefined) {
            const d = new Date();
            d.setHours(d.getHours() + h);
            expiresAt = d.toISOString();
        }

        await SystemDB.run(`INSERT INTO subscriptions (id,user_id,plan_type,expires_at,status,created_by)
            VALUES ($1,$2,$3,$4,$5,$6)`,
            [uuidv4(), userId, planType, expiresAt, 'active', createdBy]);
    }
}

module.exports = new UserController();
