/** @type {import('jest').Config} */
module.exports = {
    // بيئة Node.js (لا حاجة لـ browser APIs)
    testEnvironment: 'node',

    // مسار ملفات الاختبار
    testMatch: [
        '**/src/tests/**/*.test.js',
        '**/__tests__/**/*.test.js',
    ],

    // إعدادات اللغة
    transform: {},        // CommonJS مباشرة، لا Babel

    // مهلة زمنية لكل اختبار (5 ثوان)
    testTimeout: 5000,

    // تغطية الكود
    collectCoverage: false, // شغّل: jest --coverage لتفعيلها
    collectCoverageFrom: [
        'src/database/TransactionManager.js',
        'src/core/StateMachine.js',
        'src/api/controllers/AuthController.js',
        'src/repositories/**/*.js',
        'src/core/Container.js',
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],

    // عتبات التغطية المطلوبة
    coverageThreshold: {
        global: {
            branches:  60,
            functions: 70,
            lines:     70,
            statements: 70,
        },
    },

    // ملف الإعداد يُنفَّذ قبل كل اختبار
    setupFilesAfterFramework: [],

    // إظهار اسم كل اختبار
    verbose: true,

    // لا يُشغَّل بالتوازي (لتجنب تعارض DB mocks)
    maxWorkers: 1,

    // مسارات يُستثنى من الاختبار
    testPathIgnorePatterns: [
        '/node_modules/',
        '/dist/',
    ],

    // رسائل واضحة عند الفشل
    bail: false,
    forceExit: true,
};
