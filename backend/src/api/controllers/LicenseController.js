'use strict';
const { v4: uuidv4 } = require('uuid');
const SystemDB = require('../../database/SystemDB');

class LicenseController {

    _ip(req) {
        return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
    }

    /** GET /api/v1/admin/licenses */
    async list(req, res) {
        try {
            const { userId, status='', page=1, limit=20 } = req.query;
            const offset = (Number(page)-1)*Number(limit);
            let where = 'WHERE 1=1';
            const params = [];
            if (userId) { where += ' AND l.user_id=?'; params.push(userId); }
            if (status) { where += ' AND l.status=?'; params.push(status); }

            const lics = await SystemDB.all(`
                SELECT l.*, u.username, u.full_name
                FROM licenses l
                LEFT JOIN users u ON u.id=l.user_id
                ${where}
                ORDER BY l.issued_at DESC
                LIMIT $1 OFFSET $2`, [...params, Number(limit), offset]);

            const countRow = await SystemDB.get(`SELECT COUNT(*) as cnt FROM licenses l ${where}`, params);
            res.json({ success:true, licenses: lics, total: countRow?.cnt||0 });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في جلب التراخيص.' });
        }
    }

    /** GET /api/v1/admin/licenses/:id — جلب ترخيص بعينه */
    async getOne(req, res) {
        try {
            const lic = await SystemDB.get(`
                SELECT l.*, u.username, u.full_name
                FROM licenses l
                LEFT JOIN users u ON u.id = l.user_id
                WHERE l.id = $1`, [req.params.id]);
            if (!lic) return res.status(404).json({ success: false, error: 'الترخيص غير موجود.' });
            res.json({ success: true, license: lic });
        } catch (err) {
            res.status(500).json({ success: false, error: 'خطأ في جلب الترخيص.' });
        }
    }

    /** POST /api/v1/admin/licenses — إصدار ترخيص جديد */
    async issue(req, res) {
        try {
            const { userId, note='' } = req.body || {};
            if (!userId) return res.status(400).json({ success:false, error:'userId مطلوب.' });

            const user = await SystemDB.get('SELECT id,username FROM users WHERE id=$1', [userId]);
            if (!user) return res.status(404).json({ success:false, error:'المستخدم غير موجود.' });

            // Revoke existing active licenses
            await SystemDB.run(`UPDATE licenses SET status='revoked' WHERE user_id=$1 AND status='active'`, [userId]);

            const licKey = SystemDB._generateLicenseKey();
            const id = uuidv4();
            await SystemDB.run(`INSERT INTO licenses (id,user_id,license_key,status,issued_by,note)
                VALUES ($1,$2,$3,'active',$4,$5)`, [id, userId, licKey, req.user.id, note]);

            await SystemDB.log(req.user.id, req.user.username, 'LICENSE_ISSUED',
                `${user.username}: ${licKey}`, this._ip(req));

            res.status(201).json({ success:true, licenseKey: licKey, licenseId: id });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في إصدار الترخيص.' });
        }
    }

    /** PATCH /api/v1/admin/licenses/:id/status */
    async setStatus(req, res) {
        try {
            const { status } = req.body || {};
            if (!['active','suspended','revoked'].includes(status))
                return res.status(400).json({ success:false, error:'حالة الترخيص غير صالحة.' });

            const lic = await SystemDB.get('SELECT * FROM licenses WHERE id=$1', [req.params.id]);
            if (!lic) return res.status(404).json({ success:false, error:'الترخيص غير موجود.' });

            await SystemDB.run('UPDATE licenses SET status=$1 WHERE id=$2', [status, req.params.id]);
            await SystemDB.log(req.user.id, req.user.username, 'LICENSE_STATUS_CHANGED',
                `${req.params.id} → ${status}`, this._ip(req));

            res.json({ success:true, message:'تم تحديث حالة الترخيص.' });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في تحديث حالة الترخيص.' });
        }
    }

    /** POST /api/v1/admin/licenses/:id/reissue */
    async reissue(req, res) {
        try {
            const lic = await SystemDB.get('SELECT * FROM licenses WHERE id=$1', [req.params.id]);
            if (!lic) return res.status(404).json({ success:false, error:'الترخيص غير موجود.' });

            await SystemDB.run('UPDATE licenses SET status=$1 WHERE id=$2', ['revoked', req.params.id]);
            const newKey = SystemDB._generateLicenseKey();
            const newId  = uuidv4();
            await SystemDB.run(`INSERT INTO licenses (id,user_id,license_key,status,issued_by)
                VALUES ($1,$2,$3,'active',$4)`, [newId, lic.user_id, newKey, req.user.id]);

            await SystemDB.log(req.user.id, req.user.username, 'LICENSE_REISSUED',
                `New: ${newKey}`, this._ip(req));

            res.json({ success:true, licenseKey: newKey, licenseId: newId });
        } catch(err) {
            res.status(500).json({ success:false, error:'خطأ في إعادة الإصدار.' });
        }
    }
}

module.exports = new LicenseController();
