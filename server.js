const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" } // 允許跨網域連接
});

// 解析 JSON 請求
app.use(express.json());

// 模擬的內建管理員帳號資料庫 (可自行增加)
const USERS = {
    "admin1": "password123",
    "admin2": "map999"
};

// 儲存目前地圖上所有物件的記憶體陣列（重啟伺服器會清空）
let mapObjects = [];

// 1. 登入 API
app.post('/api/login', (express.json()), (req, res) => {
    const { username, password } = req.body;
    if (USERS[username] && USERS[username] === password) {
        res.json({ success: true, token: `mock-token-${username}` });
    } else {
        res.status(401).json({ success: false, message: "帳號或密碼錯誤" });
    }
});

// 2. 取得歷史地圖物件 API
app.get('/api/objects', (req, res) => {
    res.json(mapObjects);
});

// 3. Socket.io 即時通訊與廣播
io.on('connection', (socket) => {
    console.log('一位使用者已連線:', socket.id);

    // 監聽：有人新增了地圖物件
    socket.on('new_object', (data) => {
        // data 包含 { id, geojson, message, creator }
        mapObjects.push(data);
        // 廣播給「除自己以外」的所有人
        socket.broadcast.emit('object_added', data);
    });

    // 監聽：有人刪除了地圖物件
    socket.on('delete_object', (objectId) => {
        mapObjects = mapObjects.filter(obj => obj.id !== objectId);
        // 廣播給所有人
        socket.broadcast.emit('object_deleted', objectId);
    });

    socket.on('disconnect', () => {
        console.log('使用者已斷線:', socket.id);
    });
});

// 啟動伺服器 (Render 會自動指派 PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器正在運行於 port ${PORT}`);
});
