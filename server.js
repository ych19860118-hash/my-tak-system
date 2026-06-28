// 檔案名稱：server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 儲存每個房間的線上使用者：{ "PUBLIC_01": ["ALPHA-01", "BRAVO-02"] }
const roomUsers = {};

// 提供您的靜態 HTML 檔案 (假設您的 html 叫 index.html，放在 public 資料夾下)
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
            // 呼號重複，拒絕登入
            socket.emit('join_failed', `房間 [${room}] 中已有相同呼號 (${callsign})，請更換呼號！`);
            return;
        }

        // 登入成功：將使用者加入 Socket 房間與記錄名單
        socket.join(room);
        roomUsers[room].push(callsign);
        
        // 記錄該 socket 綁定的資訊，方便斷線時清理
        socket.callsign = callsign;
        socket.room = room;

        // 回傳成功訊息給該使用者
        socket.emit('join_success', { callsign, room });

        // 廣播給該房間內所有人更新後的名單
        io.to(room).emit('update_user_list', roomUsers[room]);
        console.log(`[${room}] ${callsign} 加入戰術網路。`);
    });

    // 2. 處理使用者斷線
    socket.on('disconnect', () => {
        const { callsign, room } = socket;
        if (room && roomUsers[room]) {
            // 將斷線者從名單中移除
            roomUsers[room] = roomUsers[room].filter(user => user !== callsign);
            // 通知房間內其他人更新名單
            io.to(room).emit('update_user_list', roomUsers[room]);
            console.log(`[${room}] ${callsign} 已離線。`);
        }
    });
});

server.listen(3000, () => {
    console.log('戰術伺服器已啟動，請連線至 http://localhost:3000');
});
