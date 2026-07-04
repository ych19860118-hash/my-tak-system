const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;
app.use(express.static(path.join(__dirname, 'public')));

// 資料結構： { "房間名稱": { objects: { "obj_id": { ...data } }, users: Set() } }
const rooms = {};

io.on('connection', (socket) => {
  let currentRoom = null;
  let currentUser = null;

  // 1. 加入房間
  socket.on('join', ({ username, room }) => {
    if (!rooms[room]) rooms[room] = { objects: {}, users: new Set() };
    
    // 檢查名稱是否重複
    if (rooms[room].users.has(username)) {
      return socket.emit('error', '該名稱在房間內已被使用');
    }

    currentRoom = room;
    currentUser = username;
    socket.join(room);
    rooms[room].users.add(username);

    // 回傳該房間目前的所有物件
    socket.emit('init-shapes', Object.values(rooms[room].objects));
    console.log(`${username} 加入了房間: ${room}`);
  });

  // 2. 新增圖形 (包含圓形、方形、多邊形等)
  socket.on('shape:add', (shape) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    
    // 標記是誰建立的
    shape.creator = currentUser;
    rooms[currentRoom].objects[shape.id] = shape;
    
    io.to(currentRoom).emit('shape:added', shape);
  });

  // 3. 更新圖形 (權限檢查)
  socket.on('shape:update', (shape) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const existing = rooms[currentRoom].objects[shape.id];
    
    // 檢查權限：只有建立者能修改
    if (existing && existing.creator === currentUser) {
      rooms[currentRoom].objects[shape.id] = shape;
      socket.to(currentRoom).emit('shape:updated', shape);
    }
  });

  // 4. 刪除圖形 (權限檢查)
  socket.on('shape:remove', (id) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const existing = rooms[currentRoom].objects[id];
    
    if (existing && existing.creator === currentUser) {
      delete rooms[currentRoom].objects[id];
      io.to(currentRoom).emit('shape:removed', id);
    }
  });

  // 5. 斷線與自動清理
  socket.on('disconnect', () => {
    if (currentRoom && rooms[currentRoom]) {
      rooms[currentRoom].users.delete(currentUser);
      // 如果房間沒人了，自動刪除房間資料
      if (rooms[currentRoom].users.size === 0) {
        delete rooms[currentRoom];
        console.log(`房間 ${currentRoom} 已清空並刪除`);
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`伺服器啟動於 port ${PORT}`);
});
