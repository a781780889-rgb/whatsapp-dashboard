'use strict';
/**
 * validate.js — Input Validation Middleware (Zod)
 * Phase 5 — FIX-16: Input Validation
 *
 * الاستخدام في routes.js:
 *   const { validate, schemas } = require('./middleware/validate');
 *   router.post('/auth/login', validate(schemas.login), AuthController.login.bind(...));
 *
 * ملاحظة: يتطلب `npm install zod` (مُضاف لـ package.json)
 */
let z;
try {
    z = require('zod');
} catch {
    // Fallback: إذا لم يكن Zod مثبتاً بعد → لا تتحقق (لكن أنبِّه)
    console.warn('[Validate] ⚠️ Zod not installed. Run: npm install zod. Validation disabled.');
    z = null;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

function buildSchemas() {
    if (!z) return {};

    return {
        // ── Auth ──────────────────────────────────────────────────────────────
        login: z.object({
            username: z.string().min(2).max(50).regex(/^[a-zA-Z0-9_@.]+$/, 'اسم المستخدم يحتوي على حروف غير مسموح بها'),
            password: z.string().min(6).max(128),
            mfaCode:  z.string().length(6).optional(),
        }),

        refresh: z.object({
            refreshToken: z.string().min(10),
        }),

        changePassword: z.object({
            oldPassword: z.string().min(6),
            newPassword: z.string().min(8).max(128),
        }),

        // ── Users ─────────────────────────────────────────────────────────────
        createUser: z.object({
            username:  z.string().min(2).max(50).regex(/^[a-zA-Z0-9_]+$/),
            password:  z.string().min(8).max(128),
            full_name: z.string().min(1).max(100).optional(),
            role:      z.enum(['admin', 'user']).default('user'),
            email:     z.string().email().optional().or(z.literal('')),
        }),

        updateUser: z.object({
            full_name: z.string().min(1).max(100).optional(),
            email:     z.string().email().optional().or(z.literal('')),
            role:      z.enum(['admin', 'user', 'super_admin']).optional(),
        }),

        // ── Accounts ──────────────────────────────────────────────────────────
        createAccount: z.object({
            name:  z.string().min(1).max(100),
            phone: z.string().min(7).max(20).regex(/^\+?[0-9]+$/, 'رقم الهاتف غير صالح').optional(),
        }),

        // ── Campaigns ─────────────────────────────────────────────────────────
        createCampaign: z.object({
            name:          z.string().min(1).max(150),
            target_type:   z.enum(['groups', 'numbers', 'members']),
            ad_library_id: z.string().uuid().optional(),
            interval_min:  z.number().int().min(1).max(3600).optional(),
            interval_max:  z.number().int().min(1).max(3600).optional(),
        }),

        // ── Subscriptions ─────────────────────────────────────────────────────
        createSubscription: z.object({
            user_id:    z.string().min(1),
            plan_type:  z.enum(['daily', 'weekly', 'monthly', 'yearly', 'lifetime']),
            start_date: z.string().datetime().optional(),
            notes:      z.string().max(500).optional(),
        }),

        // ── Groups Sync Settings ──────────────────────────────────────────────
        syncSettings: z.object({
            enabled:         z.boolean().optional(),
            interval_hours:  z.number().int().min(1).max(168).optional(),
        }),

        // ── Send Message ──────────────────────────────────────────────────────
        sendMessage: z.object({
            to:      z.string().min(5).max(30),
            message: z.string().min(1).max(4096),
            type:    z.enum(['text', 'image', 'document', 'video']).default('text'),
        }),
    };
}

const schemas = buildSchemas();

// ── Middleware Factory ────────────────────────────────────────────────────────

/**
 * validate(schema) — يُنشئ middleware للتحقق من req.body
 * @param {z.ZodSchema} schema
 * @param {'body'|'query'|'params'} source
 */
function validate(schema, source = 'body') {
    if (!z || !schema) return (req, res, next) => next(); // Zod غير متاح

    return (req, res, next) => {
        const result = schema.safeParse(req[source]);
        if (!result.success) {
            const errors = result.error.errors.map(e => ({
                field:   e.path.join('.'),
                message: e.message,
            }));
            return res.status(400).json({
                success: false,
                error:   'بيانات الطلب غير صالحة.',
                details: errors,
            });
        }
        // استبدال req.body بالبيانات المُنظَّفة (strip unknown fields)
        req[source] = result.data;
        next();
    };
}

/**
 * validateParams(schema) — يتحقق من req.params
 */
function validateParams(schema) {
    return validate(schema, 'params');
}

/**
 * validateQuery(schema) — يتحقق من req.query
 */
function validateQuery(schema) {
    return validate(schema, 'query');
}

// ── Common Param Schemas ──────────────────────────────────────────────────────
const paramSchemas = z ? {
    idParam:        z.object({ id:        z.string().min(1) }),
    accountIdParam: z.object({ accountId: z.string().min(1) }),
} : {};

module.exports = { validate, validateParams, validateQuery, schemas, paramSchemas };
