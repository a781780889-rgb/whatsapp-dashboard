#!/usr/bin/env node
/**
 * reset-admin.js — إعادة تعيين كلمة مرور المدير الرئيسي
 * الاستخدام: node reset-admin.js
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');

async function resetAdmin() {
    const { query } = require('./src/lib/postgres');
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD || '7817808899';
    
    const hash = await bcrypt.hash(password, 12);
    const result = await query(
        `UPDATE users SET password = $1, updated_at = NOW() WHERE username = $2 RETURNING id, username`,
        [hash, username]
    );
    
    if (result.rows?.length > 0) {
        console.log(`✅ تم تحديث كلمة مرور المستخدم: ${username}`);
    } else {
        console.log(`⚠️ المستخدم "${username}" غير موجود - سيتم إنشاؤه عند تشغيل الخادم`);
    }
    process.exit(0);
}

resetAdmin().catch(err => { console.error('خطأ:', err.message); process.exit(1); });
