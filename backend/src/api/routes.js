'use strict';
const express  = require('express');
const router   = express.Router();
const auth     = require('./middleware/auth');
const role     = require('./middleware/roleCheck');
const subCheck = require('./middleware/subscriptionCheck');

// ══════════════════════════════════════════════════════
//  AUTH
// ══════════════════════════════════════════════════════
const AuthController = require('./controllers/AuthController');
router.post('/auth/login',           AuthController.login.bind(AuthController));
router.post('/auth/refresh',         AuthController.refresh.bind(AuthController));
router.get('/auth/verify',   auth,   AuthController.verify.bind(AuthController));
router.post('/auth/logout',  auth,   AuthController.logout.bind(AuthController));
router.post('/auth/change-password', auth, AuthController.changePassword.bind(AuthController));

router.post('/auth/mfa/setup',  auth, AuthController.setupMFA.bind(AuthController));
router.post('/auth/mfa/verify', auth, AuthController.verifyMFA.bind(AuthController));
router.delete('/auth/mfa',      auth, AuthController.disableMFA.bind(AuthController));

// ══════════════════════════════════════════════════════
//  ADMIN — Users
// ══════════════════════════════════════════════════════
const UserController = require('./controllers/UserController');
router.get('/admin/users',              auth, role('admin'), UserController.list.bind(UserController));
router.get('/admin/users/:id',          auth, role('admin'), UserController.get.bind(UserController));
router.post('/admin/users',             auth, role('admin'), UserController.create.bind(UserController));
router.put('/admin/users/:id',          auth, role('admin'), UserController.update.bind(UserController));
router.delete('/admin/users/:id',       auth, role('admin'), UserController.delete.bind(UserController));
router.patch('/admin/users/:id/status', auth, role('admin'), UserController.setStatus.bind(UserController));

// ══════════════════════════════════════════════════════
//  ADMIN — Subscriptions
// ══════════════════════════════════════════════════════
const SubController = require('./controllers/SubscriptionController');
router.get('/admin/subscriptions',        auth, role('admin'), SubController.list.bind(SubController));
router.post('/admin/subscriptions',       auth, role('admin'), SubController.create.bind(SubController));
router.delete('/admin/subscriptions/:id', auth, role('admin'), SubController.cancel.bind(SubController));
router.get('/admin/plans',                auth, role('admin'), SubController.plans.bind(SubController));

// ══════════════════════════════════════════════════════
//  ADMIN — Licenses
// ══════════════════════════════════════════════════════
const LicenseController = require('./controllers/LicenseController');
router.get('/admin/licenses',              auth, role('admin'), LicenseController.list.bind(LicenseController));
router.post('/admin/licenses',             auth, role('admin'), LicenseController.issue.bind(LicenseController));
router.patch('/admin/licenses/:id/status', auth, role('admin'), LicenseController.setStatus.bind(LicenseController));
router.post('/admin/licenses/:id/reissue', auth, role('admin'), LicenseController.reissue.bind(LicenseController));

// ══════════════════════════════════════════════════════
//  ADMIN — Stats
// ══════════════════════════════════════════════════════
const AdminController = require('./controllers/AdminController');
router.get('/admin/stats',         auth, role('admin'), AdminController.stats.bind(AdminController));
router.get('/admin/activity-logs', auth, role('admin'), AdminController.activityLogs.bind(AdminController));

// ══════════════════════════════════════════════════════
//  ACCOUNTS
// ══════════════════════════════════════════════════════
const AccountController = require('./controllers/AccountController');
router.post('/accounts',                   auth, subCheck, AccountController.createAccount.bind(AccountController));
router.get('/accounts',                    auth, subCheck, AccountController.listAccounts.bind(AccountController));
router.get('/accounts/summary',            auth, subCheck, AccountController.getSummary.bind(AccountController));
router.get('/accounts/:id',                auth, subCheck, AccountController.getAccountDetails.bind(AccountController));
router.get('/accounts/:id/stats',          auth, subCheck, AccountController.getAccountStats.bind(AccountController));
router.get('/accounts/:id/logs',           auth, subCheck, AccountController.getLogs.bind(AccountController));
router.post('/accounts/:id/connect',       auth, subCheck, AccountController.connectAccount.bind(AccountController));
router.post('/accounts/:id/reset',         auth, subCheck, AccountController.resetSession.bind(AccountController));
router.post('/accounts/:id/disconnect',    auth, subCheck, AccountController.disconnectAccount.bind(AccountController));
router.delete('/accounts/:id',             auth, subCheck, AccountController.deleteAccount.bind(AccountController));
router.patch('/accounts/:id/role',         auth, subCheck, AccountController.updateRole.bind(AccountController));
router.post('/accounts/:id/start',         auth, subCheck, AccountController.startTasks.bind(AccountController));
router.post('/accounts/:id/stop',          auth, subCheck, AccountController.stopTasks.bind(AccountController));
router.post('/accounts/:id/restart',       auth, subCheck, AccountController.restartTasks.bind(AccountController));
router.post('/accounts/:id/test',          auth, subCheck, AccountController.testConnection.bind(AccountController));

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
router.post('/accounts/:accountId/groups/members/publish',       auth, subCheck, GroupController.publishToMembers.bind(GroupController));
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

module.exports = router;


