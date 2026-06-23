'use strict';
const jwt = require('jsonwebtoken');
let _redis = null;
const SECRET         = process.env.JWT_SECRET         || 'default_secret_change_me';
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'default_refresh_secret';

const JWTService = {
    setRedis(redis) { _redis = redis; },
    sign(payload, options = {}) {
        return jwt.sign(payload, SECRET, { expiresIn: '15m', ...options });
    },
    signRefresh(payload, options = {}) {
        return jwt.sign(payload, REFRESH_SECRET, { expiresIn: '7d', ...options });
    },
    verify(token) { return jwt.verify(token, SECRET); },
    verifyRefresh(token) { return jwt.verify(token, REFRESH_SECRET); },
    async blacklist(token) {
        if (!_redis) return;
        try { await _redis.set(`bl:${token}`, '1', 'EX', 60 * 60); } catch {}
    },
    async isBlacklisted(token) {
        if (!_redis) return false;
        try { return !!(await _redis.get(`bl:${token}`)); } catch { return false; }
    },
};
module.exports = JWTService;
