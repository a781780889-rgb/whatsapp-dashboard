'use strict';
/**
 * EncryptionService.js — AES-256-GCM Encryption
 * Phase 5 — FIX-17: Sensitive Data Encryption
 *
 * يُشفِّر البيانات الحساسة (access tokens، API keys) قبل تخزينها في قاعدة البيانات.
 * الخوارزمية: AES-256-GCM (مُصادق عليها + مُشفَّرة)
 *
 * متغيرات البيئة:
 *   ENCRYPTION_KEY — 64 hex chars (32 bytes) — يُولَّد بـ: openssl rand -hex 32
 */
const crypto = require('crypto');

const ALGORITHM  = 'aes-256-gcm';
const IV_LENGTH  = 16; // 128-bit IV
const TAG_LENGTH = 16; // 128-bit Auth Tag
const ENCODING   = 'hex';

function getKey() {
    const hexKey = process.env.ENCRYPTION_KEY;
    if (!hexKey) {
        // في بيئة التطوير: مفتاح مؤقت (لا يصلح للإنتاج)
        if (process.env.NODE_ENV !== 'production') {
            console.warn('[EncryptionService] ⚠️  ENCRYPTION_KEY not set — using dev fallback. Set it for production!');
            return Buffer.from('a'.repeat(64), ENCODING);
        }
        throw new Error('[EncryptionService] ENCRYPTION_KEY is required in production.');
    }
    if (hexKey.length !== 64) {
        throw new Error('[EncryptionService] ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate: openssl rand -hex 32');
    }
    return Buffer.from(hexKey, ENCODING);
}

class EncryptionService {

    /**
     * يُشفِّر نصاً ويُرجع: iv:authTag:ciphertext (كلها hex)
     * @param {string} plaintext
     * @returns {string} encrypted string
     */
    encrypt(plaintext) {
        if (!plaintext) return plaintext;
        const key = getKey();
        const iv  = crypto.randomBytes(IV_LENGTH);
        const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
        const encrypted = Buffer.concat([
            cipher.update(String(plaintext), 'utf8'),
            cipher.final()
        ]);
        const authTag = cipher.getAuthTag();
        // Format: iv:authTag:ciphertext (كلها hex)
        return [
            iv.toString(ENCODING),
            authTag.toString(ENCODING),
            encrypted.toString(ENCODING)
        ].join(':');
    }

    /**
     * يفك تشفير نص مُشفَّر بـ encrypt()
     * @param {string} encryptedText
     * @returns {string} plaintext
     */
    decrypt(encryptedText) {
        if (!encryptedText) return encryptedText;

        // إذا لم يكن مُشفَّراً (legacy plain text) → أرجعه كما هو
        if (!encryptedText.includes(':') || encryptedText.split(':').length !== 3) {
            return encryptedText;
        }

        try {
            const key = getKey();
            const [ivHex, tagHex, ciphertextHex] = encryptedText.split(':');
            const iv         = Buffer.from(ivHex,         ENCODING);
            const authTag    = Buffer.from(tagHex,        ENCODING);
            const ciphertext = Buffer.from(ciphertextHex, ENCODING);

            const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
            decipher.setAuthTag(authTag);

            return Buffer.concat([
                decipher.update(ciphertext),
                decipher.final()
            ]).toString('utf8');
        } catch (err) {
            console.error('[EncryptionService] Decrypt failed:', err.message);
            return null;
        }
    }

    /**
     * يتحقق إذا كان النص مُشفَّراً بالفعل
     */
    isEncrypted(text) {
        if (!text || typeof text !== 'string') return false;
        const parts = text.split(':');
        return parts.length === 3 &&
               parts[0].length === IV_LENGTH  * 2 &&
               parts[1].length === TAG_LENGTH * 2;
    }

    /**
     * يُشفِّر فقط إذا لم يكن مُشفَّراً بالفعل
     */
    encryptIfNeeded(text) {
        if (!text || this.isEncrypted(text)) return text;
        return this.encrypt(text);
    }

    /**
     * يُشفِّر object بمفاتيح مُحددة
     * @param {object} obj
     * @param {string[]} fields
     * @returns {object} new object with encrypted fields
     */
    encryptFields(obj, fields) {
        if (!obj) return obj;
        const result = { ...obj };
        for (const field of fields) {
            if (result[field]) result[field] = this.encrypt(result[field]);
        }
        return result;
    }

    /**
     * يفك تشفير object بمفاتيح مُحددة
     */
    decryptFields(obj, fields) {
        if (!obj) return obj;
        const result = { ...obj };
        for (const field of fields) {
            if (result[field]) result[field] = this.decrypt(result[field]);
        }
        return result;
    }
}

module.exports = new EncryptionService();
