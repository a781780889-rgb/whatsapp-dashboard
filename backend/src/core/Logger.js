'use strict';
const pino = require('pino');
let logger;
try {
    logger = pino({ level: process.env.LOG_LEVEL || 'info' });
} catch {
    logger = console;
    logger.info = console.log;
    logger.warn = console.warn;
    logger.error = console.error;
}
const httpLogger = (req, res, next) => { next(); };
module.exports = logger;
module.exports.httpLogger = httpLogger;
