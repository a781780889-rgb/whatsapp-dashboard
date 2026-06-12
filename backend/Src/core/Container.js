'use strict';
/**
 * Container.js — IoC / Dependency Injection Container
 * المرحلة 8: Code Quality — FIX-28: Dependency Injection
 *
 * المشكلة السابقة:
 *   كل service/controller كان يستدعي require('../../...') مباشرةً،
 *   مما يجعل:
 *     1. الاختبارات صعبة (لا يمكن استبدال Dependencies بـ mocks)
 *     2. Singleton coupling: أي تغيير في خدمة يؤثر على كل مستخدميها
 *     3. صعوبة تتبّع دورة الحياة للموارد
 *
 * الحل:
 *   Container مركزي يُسجَّل فيه كل الخدمات.
 *   كل خدمة يمكن أن تكون:
 *     - singleton: مثيل واحد طوال عمر التطبيق (الافتراضي)
 *     - transient: مثيل جديد لكل طلب
 *     - value:     قيمة ثابتة (string, number, object)
 *
 * الاستخدام:
 *   const container = require('./Container');
 *
 *   // تسجيل
 *   container.register('logger', () => require('./Logger'), { singleton: true });
 *   container.registerValue('config', { port: 3000 });
 *
 *   // استدعاء
 *   const logger = container.resolve('logger');
 */

class Container {
    constructor() {
        /** @type {Map<string, {factory: Function, opts: object}>} */
        this._registrations = new Map();
        /** @type {Map<string, any>} */
        this._singletons    = new Map();
        /** @type {Set<string>} حماية من الدوران */
        this._resolving     = new Set();
    }

    // ── التسجيل ────────────────────────────────────────────────────────────────

    /**
     * تسجيل خدمة بـ factory function
     *
     * @param {string}   name
     * @param {Function} factory   — دالة تُنشئ الخدمة، تستقبل (container) كمعامل
     * @param {object}   [opts]
     * @param {boolean}  [opts.singleton=true]   — مثيل واحد أم جديد لكل استدعاء
     */
    register(name, factory, opts = {}) {
        if (typeof factory !== 'function') {
            throw new TypeError(`Container.register('${name}'): factory must be a function`);
        }
        const resolvedOpts = { singleton: true, ...opts };
        this._registrations.set(name, { factory, opts: resolvedOpts });
        // إبطال singleton القديم إن وُجد
        this._singletons.delete(name);
        return this;
    }

    /**
     * تسجيل قيمة ثابتة (config, constants, mocks في الاختبارات)
     *
     * @param {string} name
     * @param {*}      value
     */
    registerValue(name, value) {
        this._registrations.set(name, {
            factory: () => value,
            opts: { singleton: true },
        });
        this._singletons.set(name, value);
        return this;
    }

    /**
     * تسجيل نسخة موجودة مسبقاً (singleton جاهز)
     *
     * @param {string} name
     * @param {*}      instance
     */
    registerInstance(name, instance) {
        this._registrations.set(name, {
            factory: () => instance,
            opts: { singleton: true },
        });
        this._singletons.set(name, instance);
        return this;
    }

    // ── الاستدعاء ──────────────────────────────────────────────────────────────

    /**
     * استدعاء خدمة مُسجَّلة
     *
     * @param {string} name
     * @returns {*}
     */
    resolve(name) {
        const reg = this._registrations.get(name);
        if (!reg) {
            throw new Error(`Container: '${name}' is not registered. Did you forget to call container.register()?`);
        }

        // Singleton مخزّن مسبقاً
        if (reg.opts.singleton && this._singletons.has(name)) {
            return this._singletons.get(name);
        }

        // حماية من Circular Dependencies
        if (this._resolving.has(name)) {
            throw new Error(
                `Container: Circular dependency detected while resolving '${name}'. ` +
                `Chain: ${[...this._resolving].join(' → ')} → ${name}`
            );
        }

        this._resolving.add(name);
        let instance;
        try {
            instance = reg.factory(this);
        } finally {
            this._resolving.delete(name);
        }

        if (reg.opts.singleton) {
            this._singletons.set(name, instance);
        }

        return instance;
    }

    /**
     * اختبار وجود خدمة
     * @param {string} name
     */
    has(name) {
        return this._registrations.has(name);
    }

    /**
     * إلغاء تسجيل خدمة (مفيد في الاختبارات للـ mocking)
     * @param {string} name
     */
    unregister(name) {
        this._registrations.delete(name);
        this._singletons.delete(name);
        return this;
    }

    /**
     * استبدال خدمة بـ mock (مساعد للاختبارات)
     * @param {string} name
     * @param {*}      mock
     */
    mock(name, mock) {
        return this.registerInstance(name, mock);
    }

    /**
     * إعادة تهيئة كاملة — للاختبارات فقط
     */
    reset() {
        this._registrations.clear();
        this._singletons.clear();
        this._resolving.clear();
        return this;
    }

    /**
     * قائمة الخدمات المُسجَّلة
     */
    list() {
        return [...this._registrations.keys()];
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    /**
     * تسجيل جميع خدمات التطبيق الأساسية.
     * يُستدعى مرة واحدة عند بدء التشغيل من index.js
     */
    bootstrap() {
        // ── Core ──────────────────────────────────────────────────────────────
        this.registerInstance('logger',     require('./Logger'));
        this.registerInstance('eventBus',   require('./EventBus'));
        this.registerInstance('stateMachine', require('./StateMachine'));
        this.registerInstance('jwtService', require('./JWTService'));
        this.registerInstance('encryptionService', require('./EncryptionService'));
        this.registerInstance('autoRecovery', require('./AutoRecoveryEngine'));
        this.registerInstance('sessionPersistence', require('./SessionPersistence'));

        // ── Database ──────────────────────────────────────────────────────────
        this.registerInstance('databaseManager', require('../database/DatabaseManager'));
        this.registerInstance('transactionManager', require('../database/TransactionManager'));
        this.registerInstance('systemDB', require('../database/SystemDB'));

        // ── Lib ───────────────────────────────────────────────────────────────
        this.registerInstance('redisManager', require('../lib/RedisManager'));
        this.registerInstance('cacheService', require('../lib/CacheService'));
        this.registerInstance('queueManager', require('../lib/QueueManager'));
        this.registerInstance('rateLimiter',  require('../lib/RateLimiter'));

        // ── Bot ───────────────────────────────────────────────────────────────
        this.registerInstance('whatsAppManager', require('../bot/WhatsAppManager'));

        // ── Repositories ─────────────────────────────────────────────────────
        const SystemDB = this.resolve('systemDB');
        const AccountRepository = require('../repositories/AccountRepository');
        const UserRepository    = require('../repositories/UserRepository');

        this.registerInstance('accountRepository', new AccountRepository(SystemDB));
        this.registerInstance('userRepository',    new UserRepository(SystemDB));

        return this;
    }
}

// Singleton container مشترك عبر كل التطبيق
const container = new Container();
module.exports  = container;
