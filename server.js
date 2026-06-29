// server.js (Node.js + Socket.io)
// npm install express socket.io

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public')); // HTML 放在 public/ 資料夾

// ★ 核心：每個房間的狀態倉庫
// roomState[roomID] = {
//   users: Set of callsigns,
//   layers: Map of layerId -> layerPayload
// }
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

    // ── 加入房間 ──────────────────────────────────────
    socket.on('request_join', ({ callsign, room }) => {
        if (!callsign || !room) {
            return socket.emit('join_failed', '呼號或房間代碼不得為空！');
        }

        const state = ensureRoom(room);

        // 檢查呼號是否重複
if (state.users.has(callsign)) {
        console.log(`[REJECT] ${callsign} 嘗試重複登入房間: ${room}`);
        return socket.emit('join_failed', `呼號 "${callsign}" 已在房間中，請換一個！`);
    }

        // 加入 Socket.io 房間
        socket.join(room);
        socket.callsign = callsign;
        socket.room = room;
        state.users.add(callsign);

        // 回傳登入成功
        socket.emit('join_success', { callsign, room });
    io.to(room).emit('update_user_list', Array.from(state.users));
})
        // ★ 推送歷史圖層狀態給新加入的用戶
        const history = Array.from(state.layers.values());
        if (history.length > 0) {
            socket.emit('room_state', { layers: history });
            console.log(`[SYNC] Sent ${history.length} layers to ${callsign}`);
        }

        // 廣播更新用戶列表
        io.to(room).emit('update_user_list', Array.from(state.users));
        console.log(`[JOIN] ${callsign} joined room: ${room}`);
    });

    // ── 接收客戶端動作並廣播 ──────────────────────────
    socket.on('client_action', (payload) => {
        const { room, action, id } = payload;
        if (!room || !roomState[room]) return;

        const state = roomState[room];

        if (action === 'draw') {
            // ★ 儲存新圖層到房間狀態
            state.layers.set(id, {
                ...payload,
                username: socket.callsign  // 確保用伺服器端的 callsign
            });

        } else if (action === 'move') {
            // ★ 更新圖層座標
            if (state.layers.has(id)) {
                const existing = state.layers.get(id);
                state.layers.set(id, { ...existing, data: payload.data });
            }

        } else if (action === 'color') {
            // ★ 更新圖層顏色
            if (state.layers.has(id)) {
                const existing = state.layers.get(id);
                existing.data = { ...existing.data, color: payload.data.color };
                state.layers.set(id, existing);
            }

        } else if (action === 'rename') {
            // ★ 更新圖層名稱
            if (state.layers.has(id)) {
                const existing = state.layers.get(id);
                existing.data = { ...existing.data, name: payload.data.name };
                state.layers.set(id, existing);
            }

        } else if (action === 'delete') {
            // ★ 從房間狀態中移除圖層
            // 驗證只有擁有者能刪除
            const layer = state.layers.get(id);
            if (layer && layer.username === socket.callsign) {
                state.layers.delete(id);
            } else {
                // 告知用戶無權限，不廣播刪除
                socket.emit('server_error', { msg: '無權限刪除他人標記！' });
                return;
            }
        }

        // 廣播給房間內所有人 (包含自己，前端用 username 過濾)
        io.to(room).emit('server_action', {
            ...payload,
            username: socket.callsign
        });
    });

    // ── 斷線處理 ─────────────────────────────────────
    socket.on('disconnect', () => {
        const { callsign, room } = socket;
        if (!callsign || !room || !roomState[room]) return;

        roomState[room].users.delete(callsign);
        io.to(room).emit('update_user_list', Array.from(roomState[room].users));

        // 選擇性：是否要清除該用戶的圖層 (取消註解以啟用)
        // roomState[room].layers.forEach((layer, id) => {
        //     if (layer.username === callsign) {
        //         roomState[room].layers.delete(id);
        //         io.to(room).emit('server_action', { action: 'delete', id });
        //     }
        // });

        console.log(`[-] ${callsign} left room: ${room}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`WEB-TAK Server running on port ${PORT}`));
// 1. 在檔案最上方宣告儲存資料的容器
const roomLayers = {}; 

io.on('connection', (socket) => {
    // 2. 當用戶加入房間時
    socket.on('request_join', (data) => {
        socket.join(data.room); // 讓 socket 進入該房間通道
        
        // 如果該房間有之前存的圖層，發送給這位新用戶
        if (roomLayers[data.room]) {
            socket.emit('room_sync', roomLayers[data.room]);
        }
        
        // ... 原本的 join_success 邏輯 ...
        socket.emit('join_success', data);
    });

    // 3. 處理所有動作 (繪圖、刪除、移動)
    socket.on('client_action', (payload) => {
        const { room, action, id, data } = payload;
        if (!roomLayers[room]) roomLayers[room] = [];

        if (action === 'draw') {
            roomLayers[room].push(payload); // 儲存新增圖層
        } else if (action === 'delete') {
            roomLayers[room] = roomLayers[room].filter(item => item.id !== id); // 移除圖層
        } else if (action === 'move' || action === 'style') {
            const target = roomLayers[room].find(item => item.id === id);
            if (target) Object.assign(target.data, data); // 更新既有圖層
        }

        // 廣播給房間內其他人
        socket.to(room).emit('server_action', payload);
    });
});
