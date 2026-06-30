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

// 監聽 Socket.io 連線
io.on('connection', (socket) => {
  console.log('有使用者連線了:', socket.id);

  socket.on('disconnect', () => {
    console.log('使用者斷開連線:', socket.id);
  });
});

server.listen(PORT, () => {
  console.log(`伺服器正在運行於 port ${PORT}`);
});
