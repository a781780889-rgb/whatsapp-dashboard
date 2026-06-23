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
