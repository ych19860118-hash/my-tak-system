const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

const PORT = process.env.PORT || 3000;

// 靜態檔案目錄，前端網頁會放在 public 資料夾內
app.use(express.static(path.join(__dirname, 'public')));

// 簡易記憶體儲存：共用標記 (markers)
// 資料結構範例： { id1: { id: 'id1', lat: ..., lng: ..., properties: {...} }, ... }
const markers = {};

// 回傳目前所有 markers（可供前端初次載入使用）
app.get('/api/markers', (req, res) => {
  res.json(Object.values(markers));
});

// Socket.IO 連線處理
io.on('connection', (socket) => {
  console.log('使用者連線:', socket.id);

  // 當前端連線時，發送目前所有 markers 給該使用者（初始同步）
  socket.emit('init-markers', Object.values(markers));

  // 新增標記
  socket.on('marker:add', (marker) => {
    if (!marker || !marker.id) return;
    markers[marker.id] = marker;
    // 廣播給其他使用者（不包含發送者）
    socket.broadcast.emit('marker:added', marker);
    console.log(`marker added: ${marker.id}`);
  });

  // 更新標記（例如拖曳、編輯位置或屬性）
  socket.on('marker:update', (marker) => {
    if (!marker || !marker.id) return;
    markers[marker.id] = marker;
    socket.broadcast.emit('marker:updated', marker);
    console.log(`marker updated: ${marker.id}`);
  });

  // 刪除標記
  socket.on('marker:remove', (id) => {
    if (!id) return;
    delete markers[id];
    socket.broadcast.emit('marker:removed', id);
    console.log(`marker removed: ${id}`);
  });

  socket.on('disconnect', () => {
    console.log('使用者斷線:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`伺服器正在運行於 port ${PORT}`);
});
