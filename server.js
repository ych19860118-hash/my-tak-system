const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// 修正：指向正確的靜態檔案資料夾
app.use(express.static(__dirname + '/public'));

// 如果保險起見，可以直接強制首頁導向
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// 儲存地圖物件資料結構
let shapes = {}; 

io.on('connection', (socket) => {
  let userRoom = '';

  socket.on('join', (data) => {
    userRoom = data.room;
    socket.join(userRoom);
    socket.emit('init-shapes', Object.values(shapes).filter(s => s.room === userRoom));
  });

  socket.on('shape:add', (shape) => {
    shape.room = userRoom;
    shapes[shape.id] = shape;
    io.to(userRoom).emit('shape:added', shape);
  });

  socket.on('shape:update', (updatedShape) => {
    if (!updatedShape || !updatedShape.id) return;
    if (shapes[updatedShape.id]) {
      const oldProperties = shapes[updatedShape.id].properties || {};
      const newProperties = updatedShape.properties || {};
      shapes[updatedShape.id] = { 
        ...shapes[updatedShape.id], 
        ...updatedShape,
        properties: { ...oldProperties, ...newProperties }
      };
      io.to(userRoom).emit('shape:updated', shapes[updatedShape.id]);
    }
  });

  socket.on('shape:remove', (id) => {
    if (shapes[id]) {
      delete shapes[id];
      io.to(userRoom).emit('shape:removed', id);
    }
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`伺服器執行於連接埠 ${PORT}`);
});
