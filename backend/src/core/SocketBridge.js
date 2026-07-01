'use strict';
let _io = null;
const rooms = new Map();

const SocketBridge = {
    init(io) {
        _io = io;
        io.on('connection', (socket) => {
            socket.on('join', (room) => {
                socket.join(room);
                rooms.set(room, (rooms.get(room) || 0) + 1);

                // [إصلاح تزامن النشر المباشر] عميل قد ينضم لغرفة جلسة نشر مباشر
                // بعد أن انبعثت (وضاعت) أحداث progress/log/complete الخاصة بها —
                // خصوصاً عندما تكتمل الجلسة خلال أجزاء من الثانية (مثال: تخطي
                // حساب غير متصل/غير جاهز) قبل أن يُكمل العميل مصافحة Socket.IO.
                // نرسل فوراً للعميل المنضم لقطة كاملة من حالة الجلسة (تقدّم + آخر
                // السجلات) بدل تركه بلا أي بيانات حتى الاعتماد على البولينج فقط.
                if (typeof room === 'string' && room.startsWith('live_publish:')) {
                    const sessionId = room.slice('live_publish:'.length);
                    try {
                        // require متأخر (lazy) لتفادي أي حلقة استيراد دائرية
                        // (LivePublishService يستورد SocketBridge أصلاً في أعلى ملفه).
                        const LivePublishService = require('../api/services/LivePublishService');
                        const snapshot = LivePublishService.status(sessionId);
                        if (snapshot) socket.emit('live_publish:snapshot', snapshot);
                    } catch { /* لا نكسر الاتصال لو تعذّر الجلب */ }
                }
            });
            socket.on('leave', (room) => {
                socket.leave(room);
                if (rooms.has(room)) rooms.set(room, rooms.get(room) - 1);
            });
            socket.on('disconnect', () => {});
        });
    },
    emit(event, data) { if (_io) _io.emit(event, data); },
    to(room) { return _io ? _io.to(room) : { emit: () => {} }; },
    getActiveRooms() { return Object.fromEntries(rooms); },
    getTotalConnections() { return _io ? _io.engine.clientsCount : 0; },
};
module.exports = SocketBridge;
