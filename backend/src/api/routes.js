'use strict';
const express  = require('express');
const router   = express.Router();
const auth     = require('./middleware/auth');
const role     = require('./middleware/roleCheck');
const subCheck = require('./middleware/subscriptionCheck');

// ── [FIX-15] Per-Route Rate Limiters ─────────────────────────────────────────
const {
    loginLimiter,
    refreshLimiter,
    listAccountsLimiter,
    sendMessageLimiter,
    adminLimiter,
    campaignSendLimiter,
} = require('../lib/RateLimiter');

// ── [FIX-16] Input Validation ──────────────────────────────────────────────
const { validate, schemas } = require('./middleware/validate');

// ── [FIX-14] CSRF Token Endpoint ──────────────────────────────────────────
const { csrfTokenRoute } = require('./middleware/csrf');

// ══════════════════════════════════════════════════════
//  CSRF Token
// ══════════════════════════════════════════════════════
router.get('/auth/csrf-token', csrfTokenRoute);

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════
const AuthController = require('./controllers/AuthController');
router.post('/auth/login',           loginLimiter,   validate(schemas.login),          AuthController.login.bind(AuthController));
router.post('/auth/refresh',         refreshLimiter, validate(schemas.refresh),         AuthController.refresh.bind(AuthController));
router.get('/auth/verify',   auth,                                                      AuthController.verify.bind(AuthController));
router.post('/auth/logout',  auth,                                                      AuthController.logout.bind(AuthController));
router.post('/auth/change-password', auth, validate(schemas.changePassword),            AuthController.changePassword.bind(AuthController));

router.post('/auth/mfa/setup',  auth, AuthController.setupMFA.bind(AuthController));
router.post('/auth/mfa/verify', auth, AuthController.verifyMFA.bind(AuthController));
router.delete('/auth/mfa',      auth, AuthController.disableMFA.bind(AuthController));

// ══════════════════════════════════════════════════════
//  ADMIN — Users
// ══════════════════════════════════════════════════════
const UserController = require('./controllers/UserController');
router.get('/admin/users',              auth, role('admin'), UserController.list.bind(UserController));
router.get('/admin/users/:id',          auth, role('admin'), UserController.get.bind(UserController));
router.post('/admin/users',             auth, role('admin'), adminLimiter, UserController.create.bind(UserController));
router.put('/admin/users/:id',          auth, role('admin'), UserController.update.bind(UserController));
router.delete('/admin/users/:id',       auth, role('admin'), UserController.delete.bind(UserController));
router.patch('/admin/users/:id/status', auth, role('admin'), UserController.setStatus.bind(UserController));

// ══════════════════════════════════════════════════════
//  ADMIN — Subscriptions (نظام الاشتراكات الكامل)
// ══════════════════════════════════════════════════════
const SubController = require('./controllers/SubscriptionController');

// ⚠️ يجب أن تكون المسارات الثابتة قبل المسارات الديناميكية
router.get   ('/admin/subscriptions/stats',         auth, role('admin'), SubController.stats.bind(SubController));
router.get   ('/admin/subscriptions/export',        auth, role('admin'), SubController.exportCSV.bind(SubController));
router.get   ('/admin/plans',                       auth, role('admin'), SubController.plans.bind(SubController));

// CRUD
router.get   ('/admin/subscriptions',               auth, role('admin'), SubController.list.bind(SubController));
router.post  ('/admin/subscriptions',               auth, role('admin'), SubController.create.bind(SubController));
router.delete('/admin/subscriptions/:id',           auth, role('admin'), SubController.cancel.bind(SubController));

// عمليات على اشتراك بعينه
router.post  ('/admin/subscriptions/:id/extend',    auth, role('admin'), SubController.extend.bind(SubController));
router.patch ('/admin/subscriptions/:id/freeze',    auth, role('admin'), SubController.freeze.bind(SubController));
router.patch ('/admin/subscriptions/:id/activate',  auth, role('admin'), SubController.activate.bind(SubController));
router.delete('/admin/subscriptions/:id/permanent', auth, role('admin'), SubController.deletePermanent.bind(SubController));
router.get   ('/admin/subscriptions/:id/renewals',  auth, role('admin'), SubController.renewals.bind(SubController));

// ══════════════════════════════════════════════════════
//  ADMIN — Licenses
// ══════════════════════════════════════════════════════
const LicenseController = require('./controllers/LicenseController');
router.get('/admin/licenses',              auth, role('admin'), LicenseController.list.bind(LicenseController));
router.get('/admin/licenses/:id',          auth, role('admin'), LicenseController.getOne.bind(LicenseController));
router.post('/admin/licenses',             auth, role('admin'), LicenseController.issue.bind(LicenseController));
router.patch('/admin/licenses/:id/status', auth, role('admin'), LicenseController.setStatus.bind(LicenseController));
router.post('/admin/licenses/:id/reissue', auth, role('admin'), LicenseController.reissue.bind(LicenseController));

// ══════════════════════════════════════════════════════
//  ADMIN — Stats
// ══════════════════════════════════════════════════════
const AdminController = require('./controllers/AdminController');
router.get('/admin/stats',         auth, role('admin'), AdminController.stats.bind(AdminController));
router.get('/admin/activity-logs', auth, role('admin'), AdminController.activityLogs.bind(AdminController));

// ── Admin: حذف الحسابات الوهمية (user_id=null) ───────────────────────────────
const { queryAll, query } = require('../lib/postgres');
const WhatsAppManagerAdmin = require('../bot/WhatsAppManager');
router.delete('/admin/accounts/cleanup-orphans', auth, role('admin'), async (req, res) => {
    try {
        const orphans = await queryAll(
            `SELECT id FROM accounts WHERE user_id IS NULL OR user_id NOT IN (SELECT id FROM users)`
        );
        const ids = orphans.map(r => r.id);
        if (ids.length === 0) return res.json({ success: true, deleted: 0, message: 'لا توجد حسابات وهمية' });
        for (const id of ids) {
            try { await WhatsAppManagerAdmin.fullDeleteAccount(id); } catch (_) {}
            await query(`DELETE FROM session_data WHERE account_id = $1`, [id]).catch(() => {});
            await query(`DELETE FROM accounts WHERE id = $1`, [id]).catch(() => {});
        }
        return res.json({ success: true, deleted: ids.length, ids, message: `تم حذف ${ids.length} حساب وهمي` });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ── QR Debug: حالة QR لحساب بعينه ────────────────────────────────────────────
router.get('/admin/accounts/:id/qr-debug', auth, role('admin'), async (req, res) => {
    try {
        const { id } = req.params;
        const status = WhatsAppManagerAdmin.getQrStatus(id);
        const isConn = WhatsAppManagerAdmin.isConnecting(id);
        const hasSess = !!WhatsAppManagerAdmin.getSession(id);
        res.json({ success: true, accountId: id, qrStatus: status, isConnecting: isConn, hasSession: hasSess });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ══════════════════════════════════════════════════════
//  ACCOUNTS
// ══════════════════════════════════════════════════════
const AccountController = require('./controllers/AccountController');
router.post('/accounts',                   auth, subCheck, AccountController.createAccount.bind(AccountController));
router.get('/accounts',                    auth, subCheck, listAccountsLimiter, AccountController.listAccounts.bind(AccountController));
router.get('/accounts/summary',            auth, subCheck, AccountController.getSummary.bind(AccountController));
router.get('/accounts/:id',                auth, subCheck, AccountController.getAccountDetails.bind(AccountController));
router.get('/accounts/:id/stats',          auth, subCheck, AccountController.getAccountStats.bind(AccountController));
router.get('/accounts/:id/logs',           auth, subCheck, AccountController.getLogs.bind(AccountController));
router.post('/accounts/:id/connect',       auth, subCheck, AccountController.connectAccount.bind(AccountController));
router.get('/accounts/:id/qr-status',      auth, subCheck, AccountController.getQrStatus.bind(AccountController));
router.post('/accounts/:id/connect-pairing', auth, subCheck, AccountController.connectWithPairing.bind(AccountController));
router.post('/accounts/:id/reset',         auth, subCheck, AccountController.resetSession.bind(AccountController));
router.post('/accounts/:id/disconnect',    auth, subCheck, AccountController.disconnectAccount.bind(AccountController));
router.delete('/accounts/:id',             auth, subCheck, AccountController.deleteAccount.bind(AccountController));
router.patch('/accounts/:id/role',         auth, subCheck, AccountController.updateRole.bind(AccountController));
router.post('/accounts/:id/start',         auth, subCheck, AccountController.startTasks.bind(AccountController));
router.post('/accounts/:id/stop',          auth, subCheck, AccountController.stopTasks.bind(AccountController));
router.post('/accounts/:id/restart',       auth, subCheck, AccountController.restartTasks.bind(AccountController));
router.post('/accounts/:id/test',          auth, subCheck, AccountController.testConnection.bind(AccountController));

// ── Business API Settings ─────────────────────────────────────────────────────
const BusinessAPIController = require('./controllers/BusinessAPIController');
router.get ('/accounts/:id/business-api',       auth, subCheck, BusinessAPIController.getSettings.bind(BusinessAPIController));
router.post('/accounts/:id/business-api',       auth, subCheck, BusinessAPIController.saveSettings.bind(BusinessAPIController));
router.post('/accounts/:id/business-api/test',  auth, subCheck, BusinessAPIController.testConnection.bind(BusinessAPIController));
router.post('/accounts/:id/business-api/send',  auth, subCheck, BusinessAPIController.sendMessage.bind(BusinessAPIController));

// ── WhatsApp Webhook (بدون auth — Meta يرسل مباشرة) ─────────────────────────
router.get ('/webhook/whatsapp/:accountId', BusinessAPIController.webhookVerify.bind(BusinessAPIController));
router.post('/webhook/whatsapp/:accountId', BusinessAPIController.webhookReceive.bind(BusinessAPIController));



const GroupController = require('./controllers/GroupController');
router.get('/accounts/:accountId/groups',                        auth, subCheck, GroupController.getGroups.bind(GroupController));
router.get('/accounts/:accountId/groups/categories',             auth, subCheck, GroupController.getGroupsByCategory.bind(GroupController));
router.post('/accounts/:accountId/groups/sync',                  auth, subCheck, GroupController.syncGroups.bind(GroupController));
router.get('/accounts/:accountId/groups/sync-settings',          auth, subCheck, GroupController.getSyncSettings.bind(GroupController));
router.put('/accounts/:accountId/groups/sync-settings',          auth, subCheck, GroupController.updateSyncSettings.bind(GroupController));
router.get('/accounts/:accountId/groups/:groupId/members',       auth, subCheck, GroupController.getGroupMembers.bind(GroupController));

// ══════════════════════════════════════════════════════
//  الجزء الخامس — نشر لأعضاء / تصدير / استثناءات
// ══════════════════════════════════════════════════════
router.post('/accounts/:accountId/groups/members/preview',       auth, subCheck, GroupController.getMembersForPublish.bind(GroupController));
router.post('/accounts/:accountId/groups/members/publish', sendMessageLimiter,       auth, subCheck, GroupController.publishToMembers.bind(GroupController));
router.post('/accounts/:accountId/groups/members/export-multi',  auth, subCheck, GroupController.exportMultipleGroupsMembers.bind(GroupController));
router.get('/accounts/:accountId/groups/:groupId/members/export',auth, subCheck, GroupController.exportMembers.bind(GroupController));
router.get('/accounts/:accountId/groups/saved-members',          auth, subCheck, GroupController.getSavedMembers.bind(GroupController));
router.get('/accounts/:accountId/groups/exclusions',             auth, subCheck, GroupController.getExclusions.bind(GroupController));
router.post('/accounts/:accountId/groups/exclusions',            auth, subCheck, GroupController.addExclusions.bind(GroupController));
router.delete('/accounts/:accountId/groups/exclusions',          auth, subCheck, GroupController.clearExclusions.bind(GroupController));
router.delete('/accounts/:accountId/groups/exclusions/:exclusionId', auth, subCheck, GroupController.deleteExclusion.bind(GroupController));

// ══════════════════════════════════════════════════════
//  CAMPAIGNS
// ══════════════════════════════════════════════════════
const CampaignController = require('./controllers/CampaignController');
router.post('/accounts/:accountId/campaigns',                   auth, subCheck, CampaignController.createCampaign.bind(CampaignController));
router.post('/accounts/:accountId/campaigns/preflight',         auth, subCheck, CampaignController.preflightCheck.bind(CampaignController));
router.post('/accounts/:accountId/campaigns/:campaignId/start', auth, subCheck, CampaignController.startCampaign.bind(CampaignController));
router.post('/accounts/:accountId/campaigns/:campaignId/pause', auth, subCheck, CampaignController.pauseCampaign.bind(CampaignController));
router.get('/accounts/:accountId/campaigns/:campaignId/stats',  auth, subCheck, CampaignController.getStats.bind(CampaignController));
router.get('/accounts/:accountId/campaigns',                    auth, subCheck, CampaignController.listCampaigns.bind(CampaignController));

// ══════════════════════════════════════════════════════
//  LINKS — الجزء الثالث: نظام مراقبة الروابط المتقدم
// ══════════════════════════════════════════════════════
const LinkController = require('./controllers/LinkController');
// قراءة الروابط والإحصائيات
router.get('/accounts/:accountId/links',                      auth, subCheck, LinkController.getLinks.bind(LinkController));
router.get('/accounts/:accountId/links/stats',                auth, subCheck, LinkController.getStats.bind(LinkController));
router.get('/accounts/:accountId/links/categories',           auth, subCheck, LinkController.getCategories.bind(LinkController));
router.get('/accounts/:accountId/links/export/csv',           auth, subCheck, LinkController.exportCSV.bind(LinkController));

// حذف / تصنيف
router.delete('/accounts/:accountId/links/:linkId',           auth, subCheck, LinkController.deleteLink.bind(LinkController));
router.patch('/accounts/:accountId/links/:linkId/spam',       auth, subCheck, LinkController.markSpam.bind(LinkController));
router.post('/accounts/:accountId/links/categories',          auth, subCheck, async (req, res) => res.status(501).json({ success: false, error: 'Not implemented' }));
router.patch('/accounts/:accountId/links/:linkId/categorize', auth, subCheck, async (req, res) => res.status(501).json({ success: false, error: 'Not implemented' }));

// انضمام تلقائي — نقطة الاتصال الجديدة (الجزء الثالث)
router.post('/accounts/:accountId/links/auto-join/bulk',      auth, subCheck, LinkController.bulkAutoJoin.bind(LinkController));
router.get('/accounts/:accountId/links/auto-join/queue',      auth, subCheck, LinkController.getJoinQueue.bind(LinkController));
router.delete('/accounts/:accountId/links/auto-join/queue',   auth, subCheck, LinkController.clearJoinQueue.bind(LinkController));
// رابط توافقي قديم
router.post('/accounts/:accountId/links/:linkId/auto-join',   auth, subCheck, LinkController.autoJoinLinks.bind(LinkController));

// محرك المراقبة
router.get('/accounts/:accountId/links/monitor/status',       auth, subCheck, LinkController.getMonitorStatus.bind(LinkController));

// Link Settings
const LinkSettingsController = require('./controllers/LinkSettingsController');
router.get('/accounts/:accountId/link-settings/search', auth, subCheck, LinkSettingsController.getSearchSettings.bind(LinkSettingsController));
router.put('/accounts/:accountId/link-settings/search', auth, subCheck, LinkSettingsController.updateSearchSettings.bind(LinkSettingsController));
router.get('/accounts/:accountId/link-settings/join',   auth, subCheck, LinkSettingsController.getJoinSettings.bind(LinkSettingsController));
router.put('/accounts/:accountId/link-settings/join',   auth, subCheck, LinkSettingsController.updateJoinSettings.bind(LinkSettingsController));
router.post('/accounts/:accountId/link-settings/import', auth, subCheck, LinkSettingsController.importLinks.bind(LinkSettingsController));

// ══════════════════════════════════════════════════════
//  BROADCAST — FIX: use actual method names
// ══════════════════════════════════════════════════════
const BroadcastController = require('./controllers/BroadcastController');
router.get('/accounts/:accountId/broadcast/schedules',            auth, subCheck, BroadcastController.getAll.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/schedules',           auth, subCheck, BroadcastController.create.bind(BroadcastController));
router.put('/accounts/:accountId/broadcast/schedules/:id',        auth, subCheck, async (req, res) => res.status(501).json({ success: false, error: 'Not implemented' }));
router.delete('/accounts/:accountId/broadcast/schedules/:id',     auth, subCheck, BroadcastController.delete.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/schedules/:id/pause', auth, subCheck, BroadcastController.pause.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/schedules/:id/start', auth, subCheck, BroadcastController.start.bind(BroadcastController));
router.post('/accounts/:accountId/broadcast/direct',              auth, subCheck, BroadcastController.directPublish.bind(BroadcastController));
router.get('/accounts/:accountId/broadcast/log',                  auth, subCheck, BroadcastController.getDirectPublishLog.bind(BroadcastController));

// ══════════════════════════════════════════════════════
//  AD LIBRARY — FIX: use actual method names
// ══════════════════════════════════════════════════════
const AdLibraryController = require('./controllers/AdLibraryController');
router.get('/accounts/:accountId/ads',              auth, subCheck, AdLibraryController.getAll.bind(AdLibraryController));
router.post('/accounts/:accountId/ads',             auth, subCheck, AdLibraryController.create.bind(AdLibraryController));
router.put('/accounts/:accountId/ads/:id',          auth, subCheck, AdLibraryController.update.bind(AdLibraryController));
router.delete('/accounts/:accountId/ads/:id',       auth, subCheck, AdLibraryController.delete.bind(AdLibraryController));
router.patch('/accounts/:accountId/ads/:id/toggle', auth, subCheck, async (req, res) => {
    // Toggle is_active by flipping current value
    try {
        const { accountId, id } = req.params;
        const DatabaseManager = require('../../database/DatabaseManager');
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        const ad = await accountDB.get(`SELECT is_active FROM ad_library WHERE id = $1`, [id]);
        if (!ad) return res.status(404).json({ success: false, error: 'الإعلان غير موجود' });
        await accountDB.run(`UPDATE ad_library SET is_active = $1, updated_at = NOW() WHERE id = $2`, [ad.is_active ? 0 : 1, id]);
        res.json({ success: true, is_active: !ad.is_active });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

// ══════════════════════════════════════════════════════
//  SCHEDULE — FIX: use actual method names
// ══════════════════════════════════════════════════════
const ScheduleController = require('./controllers/ScheduleController');
router.get('/accounts/:accountId/schedules',              auth, subCheck, ScheduleController.getAll.bind(ScheduleController));
router.post('/accounts/:accountId/schedules',             auth, subCheck, ScheduleController.createSchedule.bind(ScheduleController));
router.put('/accounts/:accountId/schedules/:id',          auth, subCheck, async (req, res) => res.status(501).json({ success: false, error: 'Not implemented' }));
router.delete('/accounts/:accountId/schedules/:id',       auth, subCheck, ScheduleController.deleteSchedule.bind(ScheduleController));
router.patch('/accounts/:accountId/schedules/:id/status', auth, subCheck, async (req, res) => {
    const { status } = req.body;
    if (status === 'active') return ScheduleController.startSchedule(req, res);
    return ScheduleController.pauseSchedule(req, res);
});

// ══════════════════════════════════════════════════════
//  PROTECTION — نظام الحماية المتقدم
// ══════════════════════════════════════════════════════
const ProtectionController = require('./controllers/ProtectionController');
router.get ('/protection/config',                          auth, subCheck, ProtectionController.getConfig.bind(ProtectionController));
router.put ('/protection/config',                          auth, subCheck, ProtectionController.updateConfig.bind(ProtectionController));
router.post('/protection/config/reset',                    auth, subCheck, ProtectionController.resetConfig.bind(ProtectionController));
router.get ('/protection/stats',                           auth, subCheck, ProtectionController.getStats.bind(ProtectionController));
router.get ('/protection/accounts/state',                  auth, subCheck, ProtectionController.getAccountsState.bind(ProtectionController));
router.post('/protection/accounts/:accountId/suspend',     auth, subCheck, ProtectionController.suspendAccount.bind(ProtectionController));
router.post('/protection/accounts/:accountId/resume',      auth, subCheck, ProtectionController.resumeAccount.bind(ProtectionController));
router.get ('/protection/logs',                            auth, subCheck, ProtectionController.getLogs.bind(ProtectionController));
router.get ('/protection/logs/summary',                    auth, subCheck, ProtectionController.getLogsSummary.bind(ProtectionController));
router.delete('/protection/logs',                          auth, subCheck, ProtectionController.clearLogs.bind(ProtectionController));

// ══════════════════════════════════════════════════════
//  PRIVATE CAMPAIGNS — الجزء السادس: حملات النشر الخاص
// ══════════════════════════════════════════════════════
const PrivateCampaignController = require('./controllers/PrivateCampaignController');
router.get   ('/private-campaigns',                auth, subCheck, PrivateCampaignController.listCampaigns.bind(PrivateCampaignController));
router.post  ('/private-campaigns',                auth, subCheck, PrivateCampaignController.createCampaign.bind(PrivateCampaignController));
router.get   ('/private-campaigns/:id',            auth, subCheck, PrivateCampaignController.getCampaign.bind(PrivateCampaignController));
router.post  ('/private-campaigns/:id/start',      auth, subCheck, PrivateCampaignController.startCampaign.bind(PrivateCampaignController));
router.post  ('/private-campaigns/:id/pause',      auth, subCheck, PrivateCampaignController.pauseCampaign.bind(PrivateCampaignController));
router.delete('/private-campaigns/:id',            auth, subCheck, PrivateCampaignController.deleteCampaign.bind(PrivateCampaignController));
router.get   ('/private-campaigns/:id/logs',       auth, subCheck, PrivateCampaignController.getCampaignLogs.bind(PrivateCampaignController));
router.get   ('/private-campaigns/:id/stats',      auth, subCheck, PrivateCampaignController.getStats.bind(PrivateCampaignController));

// ══════════════════════════════════════════════════════
//  DIAGNOSTICS — نظام التشخيص الاحترافي
// ══════════════════════════════════════════════════════
const DiagnosticController = require('./controllers/DiagnosticController');
router.get ('/accounts/:id/diagnostics',         auth, subCheck, DiagnosticController.getLastDiagnostic.bind(DiagnosticController));
router.get ('/accounts/:id/diagnostics/history', auth, subCheck, DiagnosticController.getDiagnosticHistory.bind(DiagnosticController));
router.post('/accounts/:id/diagnostics/scan',    auth, subCheck, DiagnosticController.runFullScan.bind(DiagnosticController));
router.get ('/admin/diagnostics',                auth, role('admin'), DiagnosticController.getAllDiagnostics.bind(DiagnosticController));
router.get ('/admin/diagnostics/stats',          auth, role('admin'), DiagnosticController.getDiagnosticStats.bind(DiagnosticController));

// ── Phase 2: Runtime Analysis ─────────────────────────────────────────────
const RuntimeController = require('./controllers/RuntimeController');
router.get ('/accounts/:id/runtime/report',                             auth, subCheck, RuntimeController.getFullReport.bind(RuntimeController));
router.get ('/accounts/:id/runtime/attempts',                           auth, subCheck, RuntimeController.getRecentAttempts.bind(RuntimeController));
router.get ('/accounts/:id/runtime/attempts/:attemptId/timeline',       auth, subCheck, RuntimeController.getAttemptTimeline.bind(RuntimeController));
router.get ('/accounts/:id/runtime/errors',                             auth, subCheck, RuntimeController.getErrorPatterns.bind(RuntimeController));
router.get ('/accounts/:id/runtime/stats',                              auth, subCheck, RuntimeController.getConnectionStats.bind(RuntimeController));
router.get ('/admin/runtime/stats',                                     auth, role('admin'), RuntimeController.getSystemStats.bind(RuntimeController));

// ── Phase 3: Connection Cycle Analysis ───────────────────────────────────────
const CycleController = require('./controllers/ConnectionCycleController');
router.get ('/accounts/:id/cycle/latest',                               auth, subCheck, CycleController.getLatestCycle.bind(CycleController));
router.get ('/accounts/:id/cycle/history',                              auth, subCheck, CycleController.getRecentCycles.bind(CycleController));
router.get ('/accounts/:id/cycle/stats',                                auth, subCheck, CycleController.getCycleStats.bind(CycleController));
router.get ('/accounts/:id/cycle/anomalies',                            auth, subCheck, CycleController.getAnomalies.bind(CycleController));
router.get ('/accounts/:id/cycle/attempts/:attemptId',                  auth, subCheck, CycleController.getCycleByAttempt.bind(CycleController));
router.get ('/accounts/:id/cycle/attempts/:attemptId/report',           auth, subCheck, CycleController.getCycleReport.bind(CycleController));
router.get ('/admin/cycle/stats',                                       auth, role('admin'), CycleController.getSystemStats.bind(CycleController));

// ── Phase 4: Database Analysis ────────────────────────────────────────────────
const DatabaseAnalyzerController = require('./controllers/DatabaseAnalyzerController');
router.get ('/accounts/:id/db/health',          auth, subCheck,        DatabaseAnalyzerController.getAccountDbHealth.bind(DatabaseAnalyzerController));
router.get ('/accounts/:id/db/check',           auth, subCheck,        DatabaseAnalyzerController.quickAccountCheck.bind(DatabaseAnalyzerController));
router.get ('/admin/db/report',                 auth, role('admin'),   DatabaseAnalyzerController.getFullReport.bind(DatabaseAnalyzerController));
router.get ('/admin/db/contradictions',         auth, role('admin'),   DatabaseAnalyzerController.getContradictions.bind(DatabaseAnalyzerController));
router.get ('/admin/db/bloat',                  auth, role('admin'),   DatabaseAnalyzerController.getBloatReport.bind(DatabaseAnalyzerController));
router.get ('/admin/db/performance',            auth, role('admin'),   DatabaseAnalyzerController.getPerformanceReport.bind(DatabaseAnalyzerController));
router.get ('/admin/db/stats',                  auth, role('admin'),   DatabaseAnalyzerController.getStats.bind(DatabaseAnalyzerController));

// ── Phase 5: Redis Analysis ───────────────────────────────────────────────────
const RedisAnalyzerController = require('./controllers/RedisAnalyzerController');
router.get ('/accounts/:id/redis/rate-keys',    auth, subCheck,        RedisAnalyzerController.getAccountRateKeys.bind(RedisAnalyzerController));
router.get ('/admin/redis/report',              auth, role('admin'),   RedisAnalyzerController.getFullReport.bind(RedisAnalyzerController));
router.get ('/admin/redis/connection',          auth, role('admin'),   RedisAnalyzerController.getConnectionInfo.bind(RedisAnalyzerController));
router.get ('/admin/redis/rate-keys',           auth, role('admin'),   RedisAnalyzerController.getAllRateKeys.bind(RedisAnalyzerController));
router.get ('/admin/redis/jwt-blacklist',       auth, role('admin'),   RedisAnalyzerController.getJWTBlacklist.bind(RedisAnalyzerController));
router.get ('/admin/redis/bullmq',              auth, role('admin'),   RedisAnalyzerController.getBullMQStatus.bind(RedisAnalyzerController));
router.get ('/admin/redis/no-ttl',              auth, role('admin'),   RedisAnalyzerController.getNoTTLKeys.bind(RedisAnalyzerController));
router.get ('/admin/redis/memory',              auth, role('admin'),   RedisAnalyzerController.getMemoryDistribution.bind(RedisAnalyzerController));

// ── Phase 6: Session Deep Analysis ───────────────────────────────────────────
const SessionAnalyzerController = require('./controllers/SessionAnalyzerController');
router.get ('/accounts/:id/session/report',        auth, subCheck,      SessionAnalyzerController.getAccountReport.bind(SessionAnalyzerController));
router.get ('/accounts/:id/session/credentials',   auth, subCheck,      SessionAnalyzerController.getCredentials.bind(SessionAnalyzerController));
router.get ('/accounts/:id/session/signal-keys',   auth, subCheck,      SessionAnalyzerController.getSignalKeys.bind(SessionAnalyzerController));
router.get ('/accounts/:id/session/stats',         auth, subCheck,      SessionAnalyzerController.getAccountStats.bind(SessionAnalyzerController));
router.get ('/admin/session/report',               auth, role('admin'),  SessionAnalyzerController.getSystemReport.bind(SessionAnalyzerController));
router.get ('/admin/session/stats',                auth, role('admin'),  SessionAnalyzerController.getSystemStats.bind(SessionAnalyzerController));
router.get ('/admin/session/stale',                auth, role('admin'),  SessionAnalyzerController.getStaleAccounts.bind(SessionAnalyzerController));

// ── المرحلة السابعة — QR Code Analysis ───────────────────────────────────
const QRAnalyzerController = require('./controllers/QRAnalyzerController');

// Per-Account
router.get ('/accounts/:id/qr/report',   auth, subCheck,      QRAnalyzerController.getAccountReport.bind(QRAnalyzerController));
router.get ('/accounts/:id/qr/stats',    auth, subCheck,      QRAnalyzerController.getAccountStats.bind(QRAnalyzerController));
router.get ('/accounts/:id/qr/history',  auth, subCheck,      QRAnalyzerController.getAccountHistory.bind(QRAnalyzerController));
router.get ('/accounts/:id/qr/latency',  auth, subCheck,      QRAnalyzerController.getLatency.bind(QRAnalyzerController));

// Admin
router.get ('/admin/qr/report',          auth, role('admin'),  QRAnalyzerController.getSystemReport.bind(QRAnalyzerController));
router.get ('/admin/qr/stats',           auth, role('admin'),  QRAnalyzerController.getSystemStats.bind(QRAnalyzerController));
router.get ('/admin/qr/slow',            auth, role('admin'),  QRAnalyzerController.getSlowAccounts.bind(QRAnalyzerController));

// ── المرحلة الثامنة — Pairing Code Analysis ──────────────────────────────
const PairingCodeAnalyzerController = require('./controllers/PairingCodeAnalyzerController');

// Per-Account
router.get ('/accounts/:id/pairing/report',   auth, subCheck,      PairingCodeAnalyzerController.getAccountReport.bind(PairingCodeAnalyzerController));
router.get ('/accounts/:id/pairing/stats',    auth, subCheck,      PairingCodeAnalyzerController.getAccountStats.bind(PairingCodeAnalyzerController));
router.get ('/accounts/:id/pairing/history',  auth, subCheck,      PairingCodeAnalyzerController.getAccountHistory.bind(PairingCodeAnalyzerController));
router.get ('/accounts/:id/pairing/latency',  auth, subCheck,      PairingCodeAnalyzerController.getLatency.bind(PairingCodeAnalyzerController));

// Admin
router.get ('/admin/pairing/report',          auth, role('admin'),  PairingCodeAnalyzerController.getSystemReport.bind(PairingCodeAnalyzerController));
router.get ('/admin/pairing/stats',           auth, role('admin'),  PairingCodeAnalyzerController.getSystemStats.bind(PairingCodeAnalyzerController));
router.get ('/admin/pairing/problematic',     auth, role('admin'),  PairingCodeAnalyzerController.getProblematicAccounts.bind(PairingCodeAnalyzerController));

// ── المرحلة التاسعة — Baileys Deep Analysis ──────────────────────────────
const BaileysAnalyzerController = require('./controllers/BaileysAnalyzerController');

// Per-Account
router.get ('/accounts/:id/baileys/report',           auth, subCheck,      BaileysAnalyzerController.getAccountReport.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/stats',            auth, subCheck,      BaileysAnalyzerController.getAccountStats.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/history',          auth, subCheck,      BaileysAnalyzerController.getAccountHistory.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/events',           auth, subCheck,      BaileysAnalyzerController.getEventBreakdown.bind(BaileysAnalyzerController));
router.get ('/accounts/:id/baileys/messages/errors',  auth, subCheck,      BaileysAnalyzerController.getMessageErrors.bind(BaileysAnalyzerController));

// Admin
router.get ('/admin/baileys/report',                  auth, role('admin'),  BaileysAnalyzerController.getSystemReport.bind(BaileysAnalyzerController));
router.get ('/admin/baileys/stats',                   auth, role('admin'),  BaileysAnalyzerController.getSystemStats.bind(BaileysAnalyzerController));
router.get ('/admin/baileys/problematic',             auth, role('admin'),  BaileysAnalyzerController.getProblematicAccounts.bind(BaileysAnalyzerController));

// ── المرحلة العاشرة — Infrastructure Analysis ─────────────────────────────
const InfrastructureController = require('./controllers/InfrastructureController');

router.get ('/admin/infra/report',           auth, role('admin'),  InfrastructureController.getSystemReport.bind(InfrastructureController));
router.get ('/admin/infra/stats',            auth, role('admin'),  InfrastructureController.getQuickStats.bind(InfrastructureController));
router.get ('/admin/infra/postgres',         auth, role('admin'),  InfrastructureController.getPostgresHealth.bind(InfrastructureController));
router.get ('/admin/infra/postgres/tables',  auth, role('admin'),  InfrastructureController.getPostgresTableStats.bind(InfrastructureController));
router.get ('/admin/infra/redis',            auth, role('admin'),  InfrastructureController.getRedisHealth.bind(InfrastructureController));
router.get ('/admin/infra/redis/keys',       auth, role('admin'),  InfrastructureController.getRedisKeyDistribution.bind(InfrastructureController));
router.get ('/admin/infra/bullmq',           auth, role('admin'),  InfrastructureController.getBullMQStats.bind(InfrastructureController));
router.get ('/admin/infra/process',          auth, role('admin'),  InfrastructureController.getProcessInfo.bind(InfrastructureController));

module.exports = router;


