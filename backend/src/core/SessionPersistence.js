'use strict';
let _redis = null;
const PREFIX = 'session:';

const SessionPersistence = {
    init(redis) { _redis = redis; },
    async save(accountId, data) {
        if (!_redis) return;
        try { await _redis.set(PREFIX + accountId, JSON.stringify(data), 'EX', 86400 * 7); } catch {}
    },
    async get(accountId) {
        if (!_redis) return null;
        try { const d = await _redis.get(PREFIX + accountId); return d ? JSON.parse(d) : null; } catch { return null; }
    },
    async delete(accountId) {
        if (!_redis) return;
        try { await _redis.del(PREFIX + accountId); } catch {}
    },
    async getSessionsToRestore() {
        if (!_redis) return [];
        try {
            const keys = await _redis.keys(PREFIX + '*');
            return keys.map(k => ({ accountId: k.replace(PREFIX, '') }));
        } catch { return []; }
    },
};
module.exports = SessionPersistence;
