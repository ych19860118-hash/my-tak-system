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
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.use('/leaflet-draw', express.static(path.join(__dirname, 'node_modules', 'leaflet-draw', 'dist')));
app.use('/leaflet-draw-images', express.static(path.join(__dirname, 'node_modules', 'leaflet-draw', 'dist', 'images')));
// 設定靜態檔案目錄，讓 Render 自動讀取 public 資料夾內的所有檔案（包含 index.html）
app.use(express.static(path.join(__dirname, 'public')));

// 模擬的內建管理員帳號資料庫 (可自行修改帳密)
const USERS = {
    "admin1": "password123",
    "admin2": "map999",
    "123": "123"
};

// 儲存目前地圖上所有物件的記憶體陣列（注意：Render 免費版伺服器閒置重啟時會清空）
let mapObjects = [];

// 1. 首頁路由：當使用者訪問網址時，直接回傳 index.html
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 2. 登入驗證 API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // 這裡的 '123' 是你們團隊的「共同通關密碼」
    if (password === '123' && username && username.trim() !== "") {
        res.json({ success: true, message: "登入成功", username: username.trim() });
    } else {
        res.json({ success: false, message: "密碼錯誤，或未輸入有效暱稱！" });
    }
});


// 3. 取得歷史地圖物件 API（供剛登入的使用者載入已有標記）
app.get('/api/objects', (req, res) => {
    res.json(mapObjects);
});

// 4. Socket.io 即時通訊與廣播
io.on('connection', (socket) => {
    console.log('一位使用者已連線:', socket.id);

    // 監聽：有人新增了地圖物件
    socket.on('new_object', (data) => {
        // data 包含 { id, geojson, message, creator }
        mapObjects.push(data);
        // 廣播給「除自己以外」的所有在線人員
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

// 啟動伺服器 (Render 部署時會自動動態指派 PORT)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`伺服器正在運行於 port ${PORT}`);
});
