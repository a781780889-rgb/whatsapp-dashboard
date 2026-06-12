const DatabaseManager = require('../../database/DatabaseManager');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const AD_LIBRARY_MAX = 30;
const MEDIA_DIR = path.resolve(__dirname, '../../../../uploads/ad-media');

class AdLibraryController {

    async getAll(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const ads = await accountDB.all(
                `SELECT * FROM ad_library ORDER BY priority DESC, created_at DESC`
            );
            const parsed = ads.map(ad => ({
                ...ad,
                media_paths: JSON.parse(ad.media_paths || '[]'),
                media_types: JSON.parse(ad.media_types || '[]'),
                links: JSON.parse(ad.links || '[]'),
                format_options: JSON.parse(ad.format_options || '{}'),
            }));
            res.json({ success: true, ads: parsed, total: parsed.length });
        } catch (err) {
            console.error('AdLibrary getAll error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async create(req, res) {
        try {
            const { accountId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            // Enforce max 30 ads
            const count = await accountDB.get(`SELECT COUNT(*) as c FROM ad_library`);
            if (count.c >= AD_LIBRARY_MAX) {
                return res.status(400).json({ success: false, error: `الحد الأقصى لمكتبة الإعلانات هو ${AD_LIBRARY_MAX} إعلان` });
            }

            const { name, content, links, format_options, priority, tags } = req.body;
            if (!name) return res.status(400).json({ success: false, error: 'اسم الإعلان مطلوب' });

            const id = crypto.randomUUID();
            await accountDB.run(
                `INSERT INTO ad_library (id, name, content, media_paths, media_types, links, format_options, priority, tags)
                 VALUES ($1, $2, $3, '[]', '[]', $4, $5, $6, $7)`,
                [id, name, content || '', JSON.stringify(links || []), JSON.stringify(format_options || {}), priority || 5, tags || '']
            );

            const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [id]);
            res.status(201).json({ success: true, ad: { ...ad, media_paths: [], media_types: [], links: links || [], format_options: format_options || {} } });
        } catch (err) {
            console.error('AdLibrary create error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async update(req, res) {
        try {
            const { accountId, adId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            const { name, content, links, format_options, priority, tags, is_active } = req.body;

            await accountDB.run(
                `UPDATE ad_library SET name=$1, content=$2, links=$3, format_options=$4, priority=$5, tags=$6, is_active=$7, updated_at=NOW() WHERE id=$8`,
                [name, content || '', JSON.stringify(links || []), JSON.stringify(format_options || {}), priority || 5, tags || '', is_active !== undefined ? (is_active ? 1 : 0) : 1, adId]
            );

            const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [adId]);
            if (!ad) return res.status(404).json({ success: false, error: 'الإعلان غير موجود' });

            res.json({ success: true, ad: { ...ad, media_paths: JSON.parse(ad.media_paths || '[]'), links: JSON.parse(ad.links || '[]') } });
        } catch (err) {
            console.error('AdLibrary update error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async delete(req, res) {
        try {
            const { accountId, adId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await accountDB.run(`DELETE FROM ad_library WHERE id = $1`, [adId]);
            res.json({ success: true, message: 'تم حذف الإعلان بنجاح' });
        } catch (err) {
            console.error('AdLibrary delete error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async uploadMedia(req, res) {
        try {
            const { accountId, adId } = req.params;
            const accountDB = await DatabaseManager.getAccountDB(accountId);

            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ success: false, error: 'لم يتم رفع أي ملف' });
            }

            // Ensure upload dir exists
            if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

            const ad = await accountDB.get(`SELECT * FROM ad_library WHERE id = $1`, [adId]);
            if (!ad) return res.status(404).json({ success: false, error: 'الإعلان غير موجود' });

            const existingPaths = JSON.parse(ad.media_paths || '[]');
            const existingTypes = JSON.parse(ad.media_types || '[]');
            const newPaths = [...existingPaths];
            const newTypes = [...existingTypes];

            for (const file of req.files) {
                const ext = path.extname(file.originalname);
                const fileName = `${adId}_${Date.now()}_${crypto.randomUUID()}${ext}`;
                const filePath = path.join(MEDIA_DIR, fileName);
                fs.writeFileSync(filePath, file.buffer);
                newPaths.push(`/uploads/ad-media/${fileName}`);
                newTypes.push(file.mimetype.startsWith('image') ? 'image' : file.mimetype.startsWith('video') ? 'video' : 'document');
            }

            await accountDB.run(
                `UPDATE ad_library SET media_paths=$1, media_types=$2, updated_at=NOW() WHERE id=$3`,
                [JSON.stringify(newPaths), JSON.stringify(newTypes), adId]
            );

            res.json({ success: true, media_paths: newPaths, media_types: newTypes });
        } catch (err) {
            console.error('AdLibrary uploadMedia error:', err);
            res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }
}

module.exports = new AdLibraryController();
