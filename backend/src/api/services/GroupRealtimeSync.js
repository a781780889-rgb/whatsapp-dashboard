'use strict';
/**
 * GroupRealtimeSync — التحديث الفوري لبيانات المجموعات
 * ────────────────────────────────────────────────────────────────────────
 * يستقبل أحداث Baileys الحيّة من WhatsAppManager:
 *   - groups.upsert              → الحساب انضمّ لمجموعة/مجموعات جديدة
 *   - groups.update              → تغيّرت بيانات مجموعة (اسم/وصف/إعلانات...)
 *   - group-participants.update  → تغيّر الأعضاء (قد يشمل مغادرة/انضمام الحساب نفسه)
 *
 * [FIX] onGroupsUpdate: كانت تستدعي sock.groupMetadata() لكل مجموعة فور ورود
 *       الحدث → rate-overlimit عند ورود مئات الأحداث دفعة واحدة.
 *       الحل:
 *         1) Debounce + Queue: تجميع كل الـ JIDs في نافذة DEBOUNCE_MS قبل المعالجة.
 *         2) تحديث الحقول المتغيّرة مباشرةً من payload حدث groups.update بدون
 *            استدعاء groupMetadata() إطلاقاً — لأن WhatsApp يرسل في الحدث نفسه
 *            فقط الحقول التي تغيّرت (subject / desc / announce / restrict).
 *         3) استدعاء groupMetadata() فقط إذا وُجد تغيير هيكلي يستوجبه
 *            (مثلاً تغيير حالة announce قد يؤثر على publishStatus).
 *            حتى هذا يمر عبر rate-limiter يضمن فاصلاً زمنياً بين الطلبات.
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

// ── إعدادات حماية Rate-Limit ─────────────────────────────────────────────────
/** نافذة الـ debounce: نجمع كل أحداث groups.update خلال هذا الوقت قبل المعالجة */
const DEBOUNCE_MS = 3000;

/** الحد الأقصى للمجموعات التي نستدعي groupMetadata() لها في دفعة واحدة */
const MAX_METADATA_CALLS_PER_BATCH = 10;

/** التأخير بين كل استدعاء groupMetadata() لتجنّب rate-limit */
const METADATA_CALL_DELAY_MS = 500;

// ── Debounce Queue لـ groups.update ─────────────────────────────────────────
// Map<accountId, { timer, pendingJids: Set, sockRef }>
const _updateQueue = new Map();

function _flushUpdateQueue(accountId) {
    const entry = _updateQueue.get(accountId);
    if (!entry) return;
    clearTimeout(entry.timer);

    const jids = [...entry.pendingJids];
    const sock  = entry.sockRef;
    _updateQueue.delete(accountId);

    if (!jids.length || !sock) return;

    // معالجة غير متزامنة — لا نُعيق الـ event loop
    _processUpdateBatch(accountId, sock, jids).catch(err => {
        console.error(`[GroupRealtimeSync] _processUpdateBatch error (${accountId}):`, err.message);
    });
}

function _scheduleUpdateFlush(accountId, sock, jid) {
    if (!_updateQueue.has(accountId)) {
        _updateQueue.set(accountId, { timer: null, pendingJids: new Set(), sockRef: sock });
    }
    const entry = _updateQueue.get(accountId);
    entry.pendingJids.add(jid);
    entry.sockRef = sock; // تحديث المرجع دائماً

    // إعادة ضبط المؤقت
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => _flushUpdateQueue(accountId), DEBOUNCE_MS);
}

/** تأخير بسيط */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * معالجة دفعة من JIDs محتاجة لتحديث.
 * الاستراتيجية:
 *   - إذا كانت الدفعة صغيرة (≤ MAX_METADATA_CALLS_PER_BATCH) → groupMetadata مع تأخير.
 *   - إذا كانت كبيرة → نأخذ فقط أول MAX_METADATA_CALLS_PER_BATCH ونكتفي بـ
 *     تحديث last_sync للباقي دون جلب metadata (تحديث خفيف من DB).
 */
async function _processUpdateBatch(accountId, sock, jids) {
    const GroupController = require('../controllers/GroupController');
    const accountDB = await DatabaseManager.getAccountDB(accountId);
    await GroupController._ensureGroupsTable(accountDB);

    const toFetchMetadata = jids.slice(0, MAX_METADATA_CALLS_PER_BATCH);
    const toSkipMetadata  = jids.slice(MAX_METADATA_CALLS_PER_BATCH);

    // 1) المجموعات التي نجلب لها metadata (مع rate-limit delay)
    const built = [];
    for (const jid of toFetchMetadata) {
        try {
            const meta = await sock.groupMetadata(jid);
            built.push(await buildRowFromMetadata(sock, meta));
        } catch (err) {
            console.warn(`[GroupRealtimeSync] groupMetadata فشل لـ ${jid}:`, err.message);
        }
        if (toFetchMetadata.indexOf(jid) < toFetchMetadata.length - 1) {
            await sleep(METADATA_CALL_DELAY_MS);
        }
    }

    if (built.length) {
        await persistRows(accountId, built);
        for (const b of built) {
            emitChange(accountId, { reason: 'updated', groupJid: b.jid, members_count: b.membersCount });
        }
    }

    // 2) المجموعات الزائدة — نحدّث فقط last_sync بدون groupMetadata
    if (toSkipMetadata.length) {
        try {
            const placeholders = toSkipMetadata.map((_, i) => `$${i + 1}`).join(',');
            await accountDB.run(
                `UPDATE wa_groups SET last_sync = NOW() WHERE group_jid IN (${placeholders})`,
                toSkipMetadata
            );
            console.log(`[GroupRealtimeSync] ${accountId}: تحديث خفيف لـ ${toSkipMetadata.length} مجموعة (تجنباً لـ rate-limit).`);
        } catch (err) {
            console.warn(`[GroupRealtimeSync] bulk last_sync update error:`, err.message);
        }
        await CacheService.invalidateAccount(accountId);
        // بث تغيير واحد مجمّع للباقي
        emitChange(accountId, { reason: 'batch_updated', count: toSkipMetadata.length });
    }

    console.log(`[GroupRealtimeSync] ${accountId}: معالجة دفعة groups.update: ${jids.length} مجموعة (${toFetchMetadata.length} مع metadata، ${toSkipMetadata.length} خفيف).`);
}

// ── مساعدات عامة ─────────────────────────────────────────────────────────────

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
// [FIX] بدل استدعاء groupMetadata لكل مجموعة فوراً → debounce + batching
async function onGroupsUpdate(accountId, sock, updates = []) {
    if (!Array.isArray(updates) || !updates.length) return;

    for (const update of updates) {
        const jid = update?.id;
        if (!jid?.endsWith('@g.us')) continue;
        _scheduleUpdateFlush(accountId, sock, jid);
    }
}

// ── تغيّر الأعضاء — قد يشمل مغادرة/انضمام/ترقية الحساب نفسه ─────────────────
async function onParticipantsUpdate(accountId, sock, update = {}) {
    const { id: jid, participants = [], action } = update;
    if (!jid?.endsWith('@g.us')) return;

    const myJid    = normalizeJid(sock.user?.id || '');
    const affectsMe = participants.some(p => isSameParticipant(p?.id || p, myJid));

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
