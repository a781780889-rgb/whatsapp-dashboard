'use strict';
/**
 * GroupRealtimeSync — التحديث الفوري لبيانات المجموعات
 * ────────────────────────────────────────────────────────────────────────
 * يستقبل أحداث Baileys الحيّة من WhatsAppManager:
 *   - groups.upsert              → الحساب انضمّ لمجموعة/مجموعات جديدة
 *   - groups.update              → تغيّرت بيانات مجموعة (اسم/وصف/إعلانات...)
 *   - group-participants.update  → تغيّر الأعضاء (قد يشمل مغادرة/انضمام الحساب نفسه)
 *
 * لكل حدث: يُحدَّث جدول wa_groups الخاص بالحساب فوراً، ثم يُبَث تغيير عبر
 * Socket.IO (event: 'groups:changed') ليتحدّث واجهة "المجموعات" تلقائياً
 * بدون أي حاجة لإعادة تحميل الصفحة، ويُمسح كاش الحساب لضمان دقّة القراءات
 * اللاحقة.
 *
 * ⚠️ يُستدعى هذا الملف بـ require متأخر (lazy) من WhatsAppManager لتجنّب
 *    أي تبعية دائرية (circular dependency) مع GroupController الذي يستورد
 *    WhatsAppManager بدوره.
 */
const DatabaseManager = require('../../database/DatabaseManager');
const CacheService    = require('../../lib/CacheService');
const SocketBridge    = require('../../core/SocketBridge');
const { v4: uuidv4 }  = require('uuid');

const AVATAR_FETCH_TIMEOUT_MS = 3000;

function normalizeJid(jid) {
    return (jid || '').replace(/:\d+@/, '@');
}

function isSameParticipant(jidA, jidB) {
    const a = normalizeJid(jidA);
    const b = normalizeJid(jidB);
    return a === b || a.split('@')[0] === b.split('@')[0];
}

function emitChange(accountId, payload) {
    try {
        SocketBridge.emit('groups:changed', { accountId, ts: new Date().toISOString(), ...payload });
    } catch (_) { /* لا نكسر التطبيق بسبب خطأ في البث */ }
}

/** بناء صفّ DB كامل من GroupMetadata — بنفس منطق GroupController._syncFromWhatsApp */
async function buildRowFromMetadata(sock, meta) {
    const GroupController = require('../controllers/GroupController');
    const myJid = normalizeJid(sock.user?.id || '');
    const jid   = meta.id;

    const myParticipant = meta.participants?.find(p => isSameParticipant(p.id, myJid));
    const isAdmin   = myParticipant?.admin === 'admin' || myParticipant?.admin === 'superadmin';
    const isMember  = !!myParticipant;
    const announce  = !!meta.announce;
    const canPublish = !announce || isAdmin;

    let publishStatus;
    if (!isMember)      publishStatus = 'red';
    else if (!announce) publishStatus = 'green';
    else if (isAdmin)   publishStatus = 'yellow';
    else                publishStatus = 'red';

    let avatarUrl = null;
    try {
        avatarUrl = await Promise.race([
            sock.profilePictureUrl(jid, 'image'),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), AVATAR_FETCH_TIMEOUT_MS)),
        ]);
    } catch (_) { /* لا صورة — طبيعي لمجموعات كثيرة */ }

    const membersCount = meta.participants?.length || 0;
    const adminsCount  = meta.participants?.filter(p => p.admin).length || 0;

    const row = [
        uuidv4(), jid,
        meta.subject || 'مجموعة بدون اسم',
        meta.desc    || '',
        meta.owner   || '',
        membersCount, adminsCount,
        announce, !!meta.restrict,
        meta.creation || 0,
        avatarUrl,
        isMember, isAdmin,
        publishStatus,
        isMember && canPublish, isMember && canPublish, isMember && canPublish,
        isMember && canPublish, isMember && canPublish, isMember && isAdmin,
        GroupController._estimateActivity(meta),
        new Date().toISOString(),
    ];

    return { row, jid, membersCount, adminsCount };
}

async function persistRows(accountId, built) {
    const GroupController = require('../controllers/GroupController');
    const accountDB = await DatabaseManager.getAccountDB(accountId);
    await GroupController._ensureGroupsTable(accountDB);
    await GroupController._batchUpsertGroups(accountDB, built.map(b => b.row));
    await CacheService.invalidateAccount(accountId);
}

// ── انضمام لمجموعة/مجموعات جديدة ────────────────────────────────────────────
async function onGroupsUpsert(accountId, sock, newGroups = []) {
    if (!Array.isArray(newGroups) || !newGroups.length) return;
    const built = [];
    for (const meta of newGroups) {
        if (!meta?.id?.endsWith('@g.us')) continue;
        try { built.push(await buildRowFromMetadata(sock, meta)); } catch (_) {}
    }
    if (!built.length) return;

    await persistRows(accountId, built);
    for (const b of built) {
        emitChange(accountId, { reason: 'joined', groupJid: b.jid, members_count: b.membersCount });
    }
    console.log(`[GroupRealtimeSync] ${accountId}: انضمّ لـ ${built.length} مجموعة جديدة.`);
}

// ── تحديث بيانات مجموعة (اسم/وصف/إعلانات/تقييد...) ─────────────────────────
async function onGroupsUpdate(accountId, sock, updates = []) {
    if (!Array.isArray(updates) || !updates.length) return;

    for (const update of updates) {
        const jid = update?.id;
        if (!jid?.endsWith('@g.us')) continue;
        try {
            const meta  = await sock.groupMetadata(jid);
            const built = await buildRowFromMetadata(sock, meta);
            await persistRows(accountId, [built]);
            emitChange(accountId, { reason: 'updated', groupJid: jid, members_count: built.membersCount });
        } catch (err) {
            console.warn(`[GroupRealtimeSync] groups.update فشل لـ ${jid}:`, err.message);
        }
    }
}

// ── تغيّر الأعضاء — قد يشمل مغادرة/انضمام/ترقية الحساب نفسه ─────────────────
async function onParticipantsUpdate(accountId, sock, update = {}) {
    const { id: jid, participants = [], action } = update;
    if (!jid?.endsWith('@g.us')) return;

    const myJid    = normalizeJid(sock.user?.id || '');
    const affectsMe = participants.some(p => isSameParticipant(p, myJid));

    try {
        // 1) الحساب غادر المجموعة أو أُزيل منها
        if (affectsMe && action === 'remove') {
            const GroupController = require('../controllers/GroupController');
            const accountDB = await DatabaseManager.getAccountDB(accountId);
            await GroupController._ensureGroupsTable(accountDB);
            await accountDB.run(`UPDATE wa_groups SET is_member = FALSE WHERE group_jid = $1`, [jid]);
            await CacheService.invalidateAccount(accountId);
            emitChange(accountId, { reason: 'left', groupJid: jid });
            console.log(`[GroupRealtimeSync] ${accountId}: غادر المجموعة ${jid}.`);
            return;
        }

        // 2) الحساب أُضيف لمجموعة (أو تغيّر دوره فيها: ترقية/تنزيل إشراف)
        if (affectsMe && (action === 'add' || action === 'promote' || action === 'demote')) {
            const meta  = await sock.groupMetadata(jid);
            const built = await buildRowFromMetadata(sock, meta);
            await persistRows(accountId, [built]);
            emitChange(accountId, {
                reason: action === 'add' ? 'joined' : 'updated',
                groupJid: jid,
                members_count: built.membersCount,
            });
            return;
        }

        // 3) تغيّر لا يخصّ الحساب نفسه (عضو آخر انضم/خرج) — حدِّث العدد فقط (خفيف)
        const meta = await sock.groupMetadata(jid);
        const GroupController = require('../controllers/GroupController');
        const accountDB = await DatabaseManager.getAccountDB(accountId);
        await GroupController._ensureGroupsTable(accountDB);
        const membersCount = meta.participants?.length || 0;
        const adminsCount  = meta.participants?.filter(p => p.admin).length || 0;
        await accountDB.run(
            `UPDATE wa_groups SET members_count = $1, admins_count = $2, last_sync = NOW() WHERE group_jid = $3`,
            [membersCount, adminsCount, jid]
        );
        await CacheService.invalidateAccount(accountId);
        emitChange(accountId, { reason: 'members_changed', groupJid: jid, members_count: membersCount });
    } catch (err) {
        console.warn(`[GroupRealtimeSync] group-participants.update خطأ لـ ${jid}:`, err.message);
    }
}

module.exports = { onGroupsUpsert, onGroupsUpdate, onParticipantsUpdate };
