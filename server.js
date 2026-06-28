// 檔案名稱：server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 儲存每個房間的線上使用者：{ "PUBLIC_01": ["ALPHA-01", "BRAVO-02"] }
const roomUsers = {};

// 提供靜態 HTML 檔案 (請確認 index.html 放在同目錄或 public 資料夾內)
app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('新連線:', socket.id);

    // 1. 處理加入房間的請求
    socket.on('request_join', (data) => {
        const { callsign, room } = data;

        // 初始化房間陣列
        if (!roomUsers[room]) roomUsers[room] = [];

        // 檢查呼號是否重複
        if (roomUsers[room].includes(callsign)) {
            socket.emit('join_failed', `房間 [${room}] 中已有相同呼號 (${callsign})，請更換呼號！`);
            return;
        }

        // 登入成功
        socket.join(room);
        roomUsers[room].push(callsign);
        
        socket.callsign = callsign;
        socket.room = room;

        socket.emit('join_success', { callsign, room });
        io.to(room).emit('update_user_list', roomUsers[room]);
        console.log(`[${room}] ${callsign} 加入戰術網路。`);
    });

    // 2. 處理使用者斷線
    socket.on('disconnect', () => {
        const { callsign, room } = socket;
        if (room && roomUsers[room]) {
            roomUsers[room] = roomUsers[room].filter(user => user !== callsign);
            io.to(room).emit('update_user_list', roomUsers[room]);
            console.log(`[${room}] ${callsign} 已離線。`);
        }
    });

    // 3. 【新增】處理戰術地圖的即時同步 (繪圖、移動、刪除)
    socket.on('client_action', (payload) => {
        const { room } = payload;
        // 將動作廣播給該房間內【除了發送者之外】的所有人
        socket.to(room).emit('server_action', payload);
        console.log(`[同步] 房間 ${room} 執行動作: ${payload.action}`);
    });
});

server.listen(3000, () => {
    console.log('戰術伺服器已啟動，請連線至 http://localhost:3000');
});
