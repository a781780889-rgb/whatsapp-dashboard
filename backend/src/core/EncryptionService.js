'use strict';
const crypto = require('crypto');
const KEY = process.env.ENCRYPTION_KEY ? Buffer.from(process.env.ENCRYPTION_KEY, 'hex') : crypto.randomBytes(32);
const ALG = 'aes-256-gcm';

const EncryptionService = {
    encrypt(text) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(ALG, KEY, iv);
        const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return iv.toString('hex') + ':' + enc.toString('hex') + ':' + tag.toString('hex');
    },
    decrypt(data) {
        const [ivHex, encHex, tagHex] = data.split(':');
        const decipher = crypto.createDecipheriv(ALG, KEY, Buffer.from(ivHex, 'hex'));
        decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
        return Buffer.concat([decipher.update(Buffer.from(encHex, 'hex')), decipher.final()]).toString('utf8');
    },
};
module.exports = EncryptionService;
