const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const roomState = {};

function ensureRoom(roomID) {
    if (!roomState[roomID]) {
        roomState[roomID] = {
            users: new Set(),
            layers: new Map()
        };
    }
    return roomState[roomID];
}

io.on('connection', (socket) => {
    console.log(`[+] Socket connected: ${socket.id}`);

    // ── 加入房間 ──
    socket.on('request_join', ({ callsign, room }) => {
        if (!callsign || !room) {
            return socket.emit('join_failed', '呼號或房間代碼不得為空！');
        }

        const state = ensureRoom(room);

        // 嚴格檢查重複
        if (state.users.has(callsign)) {
            console.log(`[REJECT] ${callsign} 嘗試重複登入房間: ${room}`);
            return socket.emit('join_failed', `呼號 "${callsign}" 已在房間中，請換一個！`);
        }

        socket.join(room);
        socket.callsign = callsign;
        socket.room = room;
        state.users.add(callsign);

        socket.emit('join_success', { callsign, room });

        // 推送歷史圖層
const history = Array.from(state.layers.values());
if (history.length > 0) {
    socket.emit('room_sync', history); // 直接傳送陣列即可
}

        io.to(room).emit('update_user_list', Array.from(state.users));
    });

    // ── 接收動作 ──
    socket.on('client_action', (payload) => {
        const { room, action, id } = payload;
        if (!room || !roomState[room]) return;

        const state = roomState[room];

        if (action === 'draw') {
            state.layers.set(id, { ...payload, username: socket.callsign });
        } else if (action === 'move') {
            if (state.layers.has(id)) {
                const existing = state.layers.get(id);
                state.layers.set(id, { ...existing, data: payload.data });
            }
        } else if (action === 'delete') {
            const layer = state.layers.get(id);
            if (layer && layer.username === socket.callsign) {
                state.layers.delete(id);
            } else {
                return;
            }
        }

        io.to(room).emit('server_action', { ...payload, username: socket.callsign });
    });

    // ── 斷線處理 ──
    socket.on('disconnect', () => {
        if (!socket.callsign || !socket.room || !roomState[socket.room]) return;

        roomState[socket.room].users.delete(socket.callsign);
        io.to(socket.room).emit('update_user_list', Array.from(roomState[socket.room].users));
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
