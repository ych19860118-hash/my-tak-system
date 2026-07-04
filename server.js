const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static(__dirname));

let shapes = {}; // 儲存地圖物件資料

io.on('connection', (socket) => {
  let userRoom = '';

  socket.on('join', (data) => {
    userRoom = data.room;
    socket.join(userRoom);
    // 送出目前房間內已有的圖形
    socket.emit('init-shapes', Object.values(shapes).filter(s => s.room === userRoom));
  });

  socket.on('shape:add', (shape) => {
    shape.room = userRoom;
    shapes[shape.id] = shape;
    io.to(userRoom).emit('shape:added', shape);
  });

  socket.on('shape:update', (updatedShape) => {
    if (shapes[updatedShape.id]) {
      shapes[updatedShape.id] = { ...shapes[updatedShape.id], ...updatedShape };
      io.to(userRoom).emit('shape:updated', shapes[updatedShape.id]);
    }
  });

  socket.on('shape:remove', (id) => {
    delete shapes[id];
    io.to(userRoom).emit('shape:removed', id);
  });
});

http.listen(3000, () => console.log('伺服器執行於 http://localhost:3000'));
