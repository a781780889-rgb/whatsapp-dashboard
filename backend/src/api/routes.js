'use strict';
/**
 * routes.js — Enterprise WhatsApp SaaS API
 * Section 6.2 + 13.4 من وثيقة التحليل:
 * مسارات جديدة مُضافة:
 * - /auth/refresh    : تجديد Access Token عبر Refresh Token
 * - /auth/mfa/setup  : إعداد MFA (TOTP) للحسابات الإدارية
 * - /auth/mfa/verify : تأكيد وتفعيل MFA
 * - /auth/mfa        : إلغاء MFA
 */
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

// MFA — Section 6.2: ضروري فوراً للحسابات الإدارية
router.post('/auth/mfa/setup',  auth, AuthController.setupMFA.bind(AuthController));
router.post('/auth/mfa/verify', auth, AuthController.verifyMFA.bind(AuthController));
router.delete('/auth/mfa',      auth, AuthController.disableMFA.bind(AuthController));

// ══════════════════════════════════════════════════════
//  ADMIN — Users
// ══════════════════════════════════════════════════════
const UserController = require('./controllers/UserController');
router.get('/admin/users',              auth, role('admin'), UserController.list);
router.get('/admin/users/:id',          auth, role('admin'), UserController.get);
router.post('/admin/users',             auth, role('admin'), UserController.create);
router.put('/admin/users/:id',          auth, role('admin'), UserController.update);
router.delete('/admin/users/:id',       auth, role('admin'), UserController.delete);
router.patch('/admin/users/:id/status', auth, role('admin'), UserController.setStatus);

// ══════════════════════════════════════════════════════
//  ADMIN — Subscriptions
// ══════════════════════════════════════════════════════
const SubController = require('./controllers/SubscriptionController');
router.get('/admin/subscriptions',        auth, role('admin'), SubController.list);
router.post('/admin/subscriptions',       auth, role('admin'), SubController.create);
router.delete('/admin/subscriptions/:id', auth, role('admin'), SubController.cancel);
router.get('/admin/plans',                auth, role('admin'), SubController.plans);

// ══════════════════════════════════════════════════════
//  ADMIN — Licenses
// ══════════════════════════════════════════════════════
const LicenseController = require('./controllers/LicenseController');
router.get('/admin/licenses',                  auth, role('admin'), LicenseController.list);
router.post('/admin/licenses',                 auth, role('admin'), LicenseController.issue);
router.patch('/admin/licenses/:id/status',     auth, role('admin'), LicenseController.setStatus);
router.post('/admin/licenses/:id/reissue',     auth, role('admin'), LicenseController.reissue);

// ══════════════════════════════════════════════════════
//  ADMIN — Stats & Logs
// ══════════════════════════════════════════════════════
const AdminController = require('./controllers/AdminController');
router.get('/admin/stats',         auth, role('admin'), AdminController.stats);
router.get('/admin/activity-logs', auth, role('admin'), AdminController.activityLogs);

// ══════════════════════════════════════════════════════
//  ACCOUNTS
// ══════════════════════════════════════════════════════
const AccountController = require('./controllers/AccountController');
router.post('/accounts',                   auth, subCheck, AccountController.createAccount);
router.get('/accounts',                    auth, subCheck, AccountController.listAccounts);
router.get('/accounts/:id',                auth, subCheck, AccountController.getAccountDetails);
router.post('/accounts/:id/connect',       auth, subCheck, AccountController.connectAccount);
router.post('/accounts/:id/disconnect',    auth, subCheck, AccountController.disconnectAccount);
router.delete('/accounts/:id',             auth, subCheck, AccountController.deleteAccount);

const GroupController = require('./controllers/GroupController');
router.get('/accounts/:accountId/groups',                   auth, subCheck, GroupController.getGroups);
router.get('/accounts/:accountId/groups/:groupId/members',  auth, subCheck, GroupController.getGroupMembers);

// ══════════════════════════════════════════════════════
//  CAMPAIGNS
// ══════════════════════════════════════════════════════
const CampaignController = require('./controllers/CampaignController');
router.post('/accounts/:accountId/campaigns',                       auth, subCheck, CampaignController.createCampaign);
router.post('/accounts/:accountId/campaigns/preflight',             auth, subCheck, CampaignController.preflightCheck);
router.post('/accounts/:accountId/campaigns/:campaignId/start',     auth, subCheck, CampaignController.startCampaign);
router.post('/accounts/:accountId/campaigns/:campaignId/pause',     auth, subCheck, CampaignController.pauseCampaign);
router.get('/accounts/:accountId/campaigns/:campaignId/stats',      auth, subCheck, CampaignController.getStats);
router.get('/accounts/:accountId/campaigns',                        auth, subCheck, CampaignController.listCampaigns);

// ══════════════════════════════════════════════════════
//  LINKS
// ══════════════════════════════════════════════════════
const LinkController = require('./controllers/LinkController');
router.get('/accounts/:accountId/links',                          auth, subCheck, LinkController.list);
router.get('/accounts/:accountId/links/stats',                    auth, subCheck, LinkController.stats);
router.get('/accounts/:accountId/links/categories',               auth, subCheck, LinkController.getCategories);
router.post('/accounts/:accountId/links/categories',              auth, subCheck, LinkController.addCategory);
router.patch('/accounts/:accountId/links/:linkId/categorize',     auth, subCheck, LinkController.categorize);
router.post('/accounts/:accountId/links/:linkId/auto-join',       auth, subCheck, LinkController.scheduleAutoJoin);
router.get('/accounts/:accountId/links/auto-join/queue',          auth, subCheck, LinkController.getJoinQueue);
router.delete('/accounts/:accountId/links/:linkId',               auth, subCheck, LinkController.deleteLink);

// Link Settings
const LinkSettingsController = require('./controllers/LinkSettingsController');
router.get('/accounts/:accountId/link-settings/search',           auth, subCheck, LinkSettingsController.getSearchSettings);
router.put('/accounts/:accountId/link-settings/search',           auth, subCheck, LinkSettingsController.updateSearchSettings);
router.get('/accounts/:accountId/link-settings/join',             auth, subCheck, LinkSettingsController.getJoinSettings);
router.put('/accounts/:accountId/link-settings/join',             auth, subCheck, LinkSettingsController.updateJoinSettings);
router.post('/accounts/:accountId/link-settings/import',          auth, subCheck, LinkSettingsController.importLinks);

// ══════════════════════════════════════════════════════
//  BROADCAST
// ══════════════════════════════════════════════════════
const BroadcastController = require('./controllers/BroadcastController');
router.get('/accounts/:accountId/broadcast/schedules',            auth, subCheck, BroadcastController.list);
router.post('/accounts/:accountId/broadcast/schedules',           auth, subCheck, BroadcastController.create);
router.put('/accounts/:accountId/broadcast/schedules/:id',        auth, subCheck, BroadcastController.update);
router.delete('/accounts/:accountId/broadcast/schedules/:id',     auth, subCheck, BroadcastController.delete);
router.post('/accounts/:accountId/broadcast/schedules/:id/pause', auth, subCheck, BroadcastController.pause);
router.post('/accounts/:accountId/broadcast/direct',              auth, subCheck, BroadcastController.directPublish);
router.get('/accounts/:accountId/broadcast/log',                  auth, subCheck, BroadcastController.getLog);

// ══════════════════════════════════════════════════════
//  AD LIBRARY
// ══════════════════════════════════════════════════════
const AdLibraryController = require('./controllers/AdLibraryController');
router.get('/accounts/:accountId/ads',          auth, subCheck, AdLibraryController.list);
router.post('/accounts/:accountId/ads',         auth, subCheck, AdLibraryController.create);
router.put('/accounts/:accountId/ads/:id',      auth, subCheck, AdLibraryController.update);
router.delete('/accounts/:accountId/ads/:id',   auth, subCheck, AdLibraryController.delete);
router.patch('/accounts/:accountId/ads/:id/toggle', auth, subCheck, AdLibraryController.toggle);

// ══════════════════════════════════════════════════════
//  SCHEDULE (Message Scheduling)
// ══════════════════════════════════════════════════════
const ScheduleController = require('./controllers/ScheduleController');
router.get('/accounts/:accountId/schedules',         auth, subCheck, ScheduleController.list);
router.post('/accounts/:accountId/schedules',        auth, subCheck, ScheduleController.create);
router.put('/accounts/:accountId/schedules/:id',     auth, subCheck, ScheduleController.update);
router.delete('/accounts/:accountId/schedules/:id',  auth, subCheck, ScheduleController.delete);
router.patch('/accounts/:accountId/schedules/:id/status', auth, subCheck, ScheduleController.setStatus);

module.exports = router;
