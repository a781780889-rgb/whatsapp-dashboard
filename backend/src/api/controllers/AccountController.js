'use strict';
/**
 * AccountController — إدارة الحسابات
 * [FIX-4]  User Isolation (Phase 1)
 * [FIX-22] Cache Layer         (Phase 6) ← جديد
 * [FIX-23] Pagination          (Phase 6) ← جديد
 */
const DatabaseManager   = require('../../database/DatabaseManager');
const WhatsAppManager   = require('../../bot/WhatsAppManager');
const AccountRoleEngine = require('../services/AccountRoleEngine');
const CacheService      = require('../../lib/CacheService');
const SystemDB          = require('../../database/SystemDB');
const crypto = require('crypto');

const VALID_ROLES = ['publisher', 'searcher', 'joiner', 'monitor', 'stopped'];

// ── مساعد تحليل pagination params ────────────────────────────────────────────
function parsePagination(query) {
    const page  = Math.max(1, parseInt(query.page  || '1',  10));
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || '50', 10)));
    const offset = (page - 1) * limit;
    return { page, limit, offset };
}

class AccountController {

    async createAccount(req, res) {
        try {
            const { name, phone_number, user_id } = req.body;
            if (!name || !name.trim()) {
                return res.status(400).json({ success: false, error: 'اسم الحساب مطلوب' });
            }
            const id = crypto.randomUUID();
            await DatabaseManager.systemDB.run(
                `INSERT INTO accounts (id, user_id, phone_number, name, role, task_status, warmup_phase, warmup_started_at)
                 VALUES ($1, $2, $3, $4, 'stopped', 'idle', TRUE, NOW())`,
                [id, user_id || null, phone_number || null, name.trim()]
            );
            await DatabaseManager.getAccountDB(id);

            // [FIX-22] مسح كاش القائمة بعد الإنشاء
            await CacheService.invalidateAccountsList();

            return res.status(201).json({
                success: true, message: 'Account created successfully', accountId: id,
                account: { id, name: name.trim(), phone_number: phone_number || null,
                    user_id: user_id || null, status: 'disconnected', role: 'stopped', task_status: 'idle' }
            });
        } catch (error) {
            console.error('Create Account Error:', error);
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── listAccounts — [FIX-22] Cache + [FIX-23] Pagination ─────────────────
    async listAccounts(req, res) {
        try {
            const isAdmin = req.user?.role === 'admin';
            const userId  = req.user?.id || req.user?.userId;

            if (!isAdmin && !userId) {
                return res.status(401).json({ success: false, error: 'غير مصرح.' });
            }

            // [FIX-23] Pagination
            const { page, limit, offset } = parsePagination(req.query);

            // [FIX-22] Cache key
            const cacheKey = CacheService.accountsKey(isAdmin ? 'admin' : userId);
            const pageCacheKey = `${cacheKey}:p${page}:l${limit}`;

            const cached = await CacheService.get(pageCacheKey);
            if (cached) {
                return res.json({ ...cached, from_cache: true });
            }

            let accounts, total;

            if (isAdmin) {
                [accounts, { count: total }] = await Promise.all([
                    DatabaseManager.systemDB.all(`
                        SELECT id, name, phone_number, status, health_status,
                               role, task_status, last_activity_at,
                               messages_sent_today, created_at, updated_at, user_id,
                               connection_type
                        FROM accounts
                        ORDER BY created_at DESC
                        LIMIT $1 OFFSET $2
                    `, [limit, offset]),
                    DatabaseManager.systemDB.get(`SELECT COUNT(*) as count FROM accounts`),
                ]);
            } else {
                [accounts, { count: total }] = await Promise.all([
                    DatabaseManager.systemDB.all(`
                        SELECT id, name, phone_number, status, health_status,
                               role, task_status, last_activity_at,
                               messages_sent_today, created_at, updated_at,
                               connection_type
                        FROM accounts
                        WHERE user_id = $1
                        ORDER BY created_at DESC
                        LIMIT $2 OFFSET $3
                    `, [userId, limit, offset]),
                    DatabaseManager.systemDB.get(
                        `SELECT COUNT(*) as count FROM accounts WHERE user_id = $1`, [userId]
                    ),
                ]);
            }

            const totalCount = parseInt(total || 0);
            const result = {
                success: true,
                accounts,
                pagination: {
                    page,
                    limit,
                    total: totalCount,
                    pages: Math.ceil(totalCount / limit),
                    has_next: offset + limit < totalCount,
                    has_prev: page > 1,
                },
            };

            // [FIX-22] حفظ في الكاش
            await CacheService.set(pageCacheKey, result, CacheService.TTL.ACCOUNTS);

            return res.json(result);
        } catch (error) {
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

            const isAdmin = req.user?.role === 'admin';
            const userId  = req.user?.id || req.user?.userId;
            if (!isAdmin && account.user_id !== userId) {
                return res.status(403).json({ success: false, error: 'غير مصرح بالوصول لهذا الحساب.' });
            }
            return res.json({ success: true, account });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── getAccountStats — [FIX-22] Cache ────────────────────────────────────
    async getAccountStats(req, res) {
        try {
            const { id } = req.params;
            const cacheKey = CacheService.statsKey(id);

            const cached = await CacheService.get(cacheKey);
            if (cached) return res.json({ ...cached, from_cache: true });

            const account = await DatabaseManager.systemDB.get(
                `SELECT * FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            const accountDB = await DatabaseManager.getAccountDB(id);
            const [groupsRow, adsRow, msgsRow, schedulesRow, linksRow] = await Promise.all([
                accountDB.get(`SELECT COUNT(*) as cnt FROM groups`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM ad_library WHERE is_active = TRUE`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM messages`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM broadcast_schedules WHERE status = 'active'`),
                accountDB.get(`SELECT COUNT(*) as cnt FROM extracted_links`),
            ]);

            const result = {
                success: true,
                stats: {
                    groups:          parseInt(groupsRow?.cnt  || 0),
                    activeAds:       parseInt(adsRow?.cnt     || 0),
                    messagesSent:    parseInt(msgsRow?.cnt    || 0),
                    activeSchedules: parseInt(schedulesRow?.cnt || 0),
                    extractedLinks:  parseInt(linksRow?.cnt   || 0),
                    role:            account.role,
                    taskStatus:      account.task_status,
                    lastActivity:    account.last_activity_at,
                    healthStatus:    account.health_status,
                },
            };

            await CacheService.set(cacheKey, result, CacheService.TTL.STATS);
            return res.json(result);
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async getSummary(req, res) {
        try {
            const summary = await AccountRoleEngine.getSummary();
            return res.json({ success: true, summary });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async updateRole(req, res) {
        try {
            const { id } = req.params;
            const { role } = req.body;
            if (!VALID_ROLES.includes(role)) {
                return res.status(400).json({ success: false, error: `دور غير صالح. الأدوار: ${VALID_ROLES.join(', ')}` });
            }
            const account = await DatabaseManager.systemDB.get(`SELECT id FROM accounts WHERE id = $1`, [id]);
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            await AccountRoleEngine.setAccountRole(id, role);
            if (role === 'stopped') await AccountRoleEngine.stopAccount(id);

            // [FIX-22] مسح كاش بعد تغيير الدور
            await CacheService.invalidateAccountsList();
            await CacheService.del(CacheService.statsKey(id));

            return res.json({ success: true, message: `تم تغيير دور الحساب إلى: ${role}`, role });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async startTasks(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id, role, status FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            if (account.status !== 'connected') {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب.' });
            }
            if (account.role === 'stopped') {
                return res.status(400).json({ success: false, error: 'يرجى تحديد دور للحساب.' });
            }
            await AccountRoleEngine.startAccount(id);
            return res.json({ success: true, message: `تم تشغيل مهام الحساب (دور: ${account.role})` });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async stopTasks(req, res) {
        try {
            const { id } = req.params;
            await AccountRoleEngine.stopAccount(id);
            return res.json({ success: true, message: 'تم إيقاف مهام الحساب' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async restartTasks(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id, role, status FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            await AccountRoleEngine.stopAccount(id);
            await new Promise(r => setTimeout(r, 1000));
            if (account.status === 'connected' && account.role !== 'stopped') {
                await AccountRoleEngine.startAccount(id);
            }
            return res.json({ success: true, message: 'تمت إعادة تشغيل المهام' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async testConnection(req, res) {
        try {
            const { id } = req.params;
            const session = WhatsAppManager.getSession(id);
            if (!session) {
                return res.status(400).json({ success: false, error: 'الحساب غير متصل بواتساب.' });
            }
            return res.json({ success: true, message: 'الاتصال يعمل بشكل صحيح', status: 'connected' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    async deleteAccount(req, res) {
        try {
            const { id } = req.params;
            const isAdmin = req.user?.role === 'admin';
            const userId  = req.user?.id || req.user?.userId;

            const account = await DatabaseManager.systemDB.get(
                `SELECT * FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });
            if (!isAdmin && account.user_id !== userId) {
                return res.status(403).json({ success: false, error: 'غير مصرح.' });
            }

            // إيقاف الجلسة أولاً (logout آمن + تنظيف الذاكرة/Redis)
            try { await WhatsAppManager.fullDeleteAccount(id); } catch (_) {}

            // [FIX-SESSION-LEAK] حذف بيانات Auth State المحفوظة (creds + signal keys)
            // من قاعدة البيانات. بدون هذا، تبقى صفوف مشفرة يتيمة في session_data
            // مرتبطة بحساب محذوف إلى الأبد — تسرّب بيانات وتراكم غير ضروري في DB.
            await SystemDB.deleteAllSessionData(id).catch(console.error);

            await DatabaseManager.systemDB.run(`DELETE FROM accounts WHERE id = $1`, [id]);

            // [FIX-22] مسح كاش الحساب المحذوف
            await CacheService.invalidateAccount(id);
            await CacheService.invalidateAccountsList();

            return res.json({ success: true, message: 'تم حذف الحساب' });
        } catch (error) {
            return res.status(500).json({ success: false, error: 'Internal Server Error' });
        }
    }

    // ── POST /accounts/:id/connect ────────────────────────────────────────────
    async connectAccount(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT * FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            // [FIX-DUPLICATE-CONNECT] منع طلبات متزامنة (مثل ضغط الزر مرتين) من
            // إنشاء socketين متنافسين على نفس بيانات الحساب — سبب جذري لحلقات 515/500.
            if (WhatsAppManager.isConnecting(id)) {
                return res.status(409).json({
                    success: false,
                    error: 'هناك عملية ربط جارية لهذا الحساب بالفعل. يرجى الانتظار حتى تنتهي.',
                });
            }

            // ✅ FIX-QR: استخدام startFreshQRSession بدلاً من initSession مباشرة
            // السبب: initSession تتخطى QR إذا كانت هناك بيانات جلسة قديمة (registered=true)
            //        أو إذا كان connection_type='pairing_code' في قاعدة البيانات
            // startFreshQRSession تمسح كل شيء وتبدأ جلسة QR نظيفة
            WhatsAppManager.startFreshQRSession(id).catch(() => {});
            return res.json({ success: true, message: 'جارٍ إنشاء رمز QR...' });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:id/qr-status ──────────────────────────────────────────
    async getQrStatus(req, res) {
        try {
            const { id } = req.params;
            // منع الـ HTTP caching تماماً — هذا endpoint يتغير باستمرار
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');
            const status = WhatsAppManager.getQrStatus(id);
            return res.json({ success: true, ...status });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── POST /accounts/:id/connect-pairing ───────────────────────────────────
    async connectWithPairing(req, res) {
        try {
            const { id } = req.params;
            const account = await DatabaseManager.systemDB.get(
                `SELECT id FROM accounts WHERE id = $1`, [id]
            );
            if (!account) return res.status(404).json({ success: false, error: 'Account not found' });

            // الفرونت يُرسل phone_number أو phone - نقبل كلاهما
            const { phone, phone_number } = req.body || {};
            const rawPhone = phone || phone_number;
            if (!rawPhone) return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });

            // ✅ FIX-PAIRING: التحقق من تنسيق الرقم قبل البدء
            const cleanPhone = rawPhone.replace(/\D/g, '');
            if (cleanPhone.length < 10) {
                return res.status(400).json({ success: false, error: 'رقم الهاتف قصير جداً. تأكد من إدخال رمز الدولة ورقم الهاتف كاملاً.' });
            }
            if (cleanPhone.length > 15) {
                return res.status(400).json({ success: false, error: 'رقم الهاتف طويل جداً. تأكد من صحة الرقم المُدخل.' });
            }
            if (cleanPhone.startsWith('00')) {
                return res.status(400).json({ success: false, error: 'أدخل الرقم بدون 00 في البداية. مثال: 9665XXXXXXXX' });
            }

            // [FIX-DUPLICATE-CONNECT] منع طلبات متزامنة لنفس الحساب — نفس سبب الإصلاح في connectAccount
            if (WhatsAppManager.isConnecting(id)) {
                return res.status(409).json({
                    success: false,
                    error: 'هناك عملية ربط جارية لهذا الحساب بالفعل. يرجى الانتظار حتى تنتهي.',
                });
            }

            // ✅ FIX-PAIRING: fire & forget — لا تنتظر حتى ينتهي (قد يستغرق 45 ثانية)
            //    الأحداث تصل عبر Socket.IO
            WhatsAppManager.initPairingSession(id, cleanPhone).catch((err) => {
                console.error(`[PAIRING_FAILED] Account ${id}: initPairingSession error:`, err.message);
            });

            return res.json({ success: true, message: 'جارٍ إنشاء رمز الإقران...' });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── POST /accounts/:id/reset ─────────────────────────────────────────────
    async resetSession(req, res) {
        try {
            const { id } = req.params;
            await WhatsAppManager.forceResetSession(id);
            return res.json({ success: true, message: 'تمت إعادة تعيين الجلسة' });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── POST /accounts/:id/disconnect ────────────────────────────────────────
    async disconnectAccount(req, res) {
        try {
            const { id } = req.params;
            // ✅ FIX: disconnectAccount الآن موجودة في WhatsAppManager
            await WhatsAppManager.disconnectAccount(id);
            return res.json({ success: true, message: 'تم قطع الاتصال' });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }

    // ── GET /accounts/:id/logs ───────────────────────────────────────────────
    async getLogs(req, res) {
        try {
            const { id } = req.params;
            const limit = parseInt(req.query.limit) || 100;
            const logs = await DatabaseManager.systemDB.all(
                `SELECT * FROM activity_logs WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
                [id, limit]
            ).catch(() => []);
            return res.json({ success: true, logs });
        } catch (error) {
            return res.status(500).json({ success: false, error: error.message });
        }
    }
}

module.exports = new AccountController();
