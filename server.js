// 檔案名稱：server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 儲存每個房間的線上使用者
const roomUsers = {};
// 儲存每個房間的圖層歷史 (包含顏色資訊)
const roomLayers = {};

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('新連線:', socket.id);

    // 1. 處理加入房間的請求
    socket.on('request_join', (data) => {
        const { callsign, room } = data;

        if (!roomUsers[room]) roomUsers[room] = [];
        if (roomUsers[room].includes(callsign)) {
            socket.emit('join_failed', `房間 [${room}] 中已有相同呼號 (${callsign})，請更換呼號！`);
            return;
        }

        socket.join(room);
        roomUsers[room].push(callsign);
        socket.callsign = callsign;
        socket.room = room;

        socket.emit('join_success', { callsign, room });
        
        // 當新用戶加入時，發送房間所有歷史圖層 (含顏色)
        if (roomLayers[room]) {
            roomLayers[room].forEach(layerData => {
                socket.emit('server_action', layerData);
            });
        }

        io.to(room).emit('update_user_list', roomUsers[room]);
        console.log(`[${room}] ${callsign} 加入，已同步歷史資料。`);
    });

    // 2. 處理使用者斷線
    socket.on('disconnect', () => {
        const { callsign, room } = socket;
        if (room && roomUsers[room]) {
            roomUsers[room] = roomUsers[room].filter(user => user !== callsign);
            io.to(room).emit('update_user_list', roomUsers[room]);
        }
    });

    // 3. 處理戰術地圖的即時同步 (含繪圖、移動、刪除、顏色變更)
    socket.on('client_action', (payload) => {
        const { room, action, id, data, username } = payload;
        
        if (!roomLayers[room]) roomLayers[room] = [];

        if (action === 'rename' || action === 'color') {
            const roomLayersList = roomLayers[room] || [];
            const idx = roomLayersList.findIndex(l => l.id === id);
            
            // 檢查：只有圖層原本的建立者才能修改
            if (idx !== -1 && roomLayersList[idx].username !== username) {
                console.log("偵測到非法修改請求");
                return; // 拒絕執行
            }
        }
        // ★ 新增：支援修改名稱的紀錄更新 ★
        else if (action === 'rename') {
            const idx = roomLayers[room].findIndex(l => l.id === id);
            if (idx !== -1) {
                if (!roomLayers[room][idx].data) roomLayers[room][idx].data = {};
                roomLayers[room][idx].data.name = data.name;
            }
        }

        // 廣播給該房間內所有人
        socket.to(room).emit('server_action', payload);
        console.log(`[同步] 房間 ${room} 執行動作: ${action}`);
    });
}); // <--- ★ 修正：這裡補上了原先漏掉的整個連線結尾括號
