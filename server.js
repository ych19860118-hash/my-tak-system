const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// 🔍 【偵錯專用】檢查伺服器路徑
const publicPath = path.join(__dirname, 'public');
console.log("--------------------------------------------------");
console.log("📂 伺服器目前執行目錄 (__dirname):", __dirname);
console.log("🎯 Express 正在尋找的 public 路徑:", publicPath);
console.log("❓ 該 public 資料夾是否存在？:", fs.existsSync(publicPath) ? "✅ 是" : "❌ 否");
if (fs.existsSync(publicPath)) {
    console.log("📄 public 資料夾裡面的檔案有:", fs.readdirSync(publicPath));
}
console.log("--------------------------------------------------");

// 讓 Express 讀取靜態檔案
app.use(express.static(publicPath));

// 儲存各個房間兵棋歷史紀錄的記憶體物件
const roomLayers = {};
// 🎯 新增：儲存各房間內的線上使用者名單
const roomUsers = {};

io.on('connection', (socket) => {
    console.log('🟢 有新終端連線:', socket.id);
    
   // 1. 隊員加入戰術頻道
socket.on('join_room', (data) => {
    const room = data.room;
    const username = data.username || "未知隊員";

    // --- 🚀 關鍵修改開始 ---
    if (!roomUsers[room]) roomUsers[room] = [];

    // 檢查該房間內是否已經存在此呼號
    if (roomUsers[room].includes(username)) {
        console.log(`⚠️ 拒絕重複登入: [${username}]`);
        // 發送錯誤訊息給客戶端，讓前端跳出警告並切回登入畫面
        socket.emit('login_error', { message: `⚠️ 錯誤：呼號 [${username}] 已在該房間內。` });
        return; // ⚠️ 直接中斷，不讓該 socket 進入房間
    }
    // --- 🚀 關鍵修改結束 ---

    socket.join(room);
    console.log(`⛺ [${username}] 進入了戰術房間: ${room}`);
    
    // 建立該房間的歷史快取
    if (!roomLayers[room]) roomLayers[room] = {};
    
    // 將自己加入房間名單
    roomUsers[room].push(username);
    
    // 紀錄當前連線綁定的用戶名與房間，方便斷線時清除
    socket.username = username;
    socket.room = room;

    // 將目前房間內所有人名單同步給該使用者
    socket.emit('init_user_list', roomUsers[room]);
    
    // 將歷史兵棋回傳給新加入的人
    socket.emit('init_layers', roomLayers[room]);
    
    // 廣播給同房間的其他人：有新人來了
    socket.to(room).emit('user_joined', { username: username });
});

// 在 socket.on('place_marker', ...) 中加入檢查
socket.on('place_marker', (data) => {
    const room = data.room;
    const existing = roomLayers[room] ? roomLayers[room][data.id] : null;

    // 如果已經存在，檢查權限
    if (existing && existing.owner !== socket.username && socket.username !== "COMMANDER") {
        console.log(`🚫 非法修改嘗試: [${socket.username}] 想修改 [${existing.owner}] 的圖層`);
        return; 
    }
    
    // 若通過檢查，或是新建的，則儲存 (確保寫入 owner 資訊)
    if (!roomLayers[room]) roomLayers[room] = {};
    data.owner = data.owner || socket.username; // 確保有 owner 資訊
    roomLayers[room][data.id] = data;
    
    socket.to(room).emit('receive_marker', data);
});

    // 3. 刪除單一物件
    socket.on('delete_layer', (data) => {
        const room = data.room;
        if (room && roomLayers[room] && roomLayers[room][data.id]) {
            delete roomLayers[room][data.id];
            socket.to(room).emit('layer_removed', data.id);
        }
    });

    // 4. 清空全房間標繪
    socket.on('clear_all', (data) => {
        const room = data.room;
        if (room) {
            roomLayers[room] = {};
            socket.to(room).emit('all_cleared');
        }
    });

    // 🎯 補上斷線時自動從房間名單清除的機制
    socket.on('disconnect', () => {
        console.log('🔴 終端中斷連線:', socket.id);
        const room = socket.room;
        const username = socket.username;
        if (room && roomUsers[room]) {
            // 從名單中過濾掉離開的人
            roomUsers[room] = roomUsers[room].filter(u => u !== username);
            // 通知同房間的其他人某人下線了，以便即時更新人數名單
            socket.to(room).emit('user_left', { username: username });
        }
    });
});

// 🎯 優先讀取環境變數 PORT，如果沒有（本地端）就用 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 TAK 伺服器已在連接埠 ${PORT} 啟動完成！`);
});
