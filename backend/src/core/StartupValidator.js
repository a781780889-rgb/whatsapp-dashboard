'use strict';
function validate() {
    const PORT = parseInt(process.env.PORT || '8080', 10);
    if (!process.env.DATABASE_URL) console.warn('[StartupValidator] WARNING: DATABASE_URL not set');
    if (!process.env.REDIS_URL)    console.warn('[StartupValidator] WARNING: REDIS_URL not set');
    console.log(`[StartupValidator] PORT=${PORT} | ENV=${process.env.NODE_ENV || 'development'}`);
    return PORT;
}
module.exports = { validate };
