')(http);

app.use(express.static(__dirname));

// 儲存地圖物件資料結構：{ [id]: shapeObject }
let shapes = {}; 

io.on('connection', (socket) => {
  let userRoom = '';

  // 使用者加入房間
  socket.on('join', (data) => {
    userRoom = data.room;
    socket.join(userRoom);
    // 送出目前房間內已有的圖形
    socket.emit('init-shapes', Object.values(shapes).filter(s => s.room === userRoom));
  });

  // 新增圖形
  socket.on('shape:add', (shape) => {
    shape.room = userRoom;
    shapes[shape.id] = shape;
    io.to(userRoom).emit('shape:added', shape);
  });

  // 更新圖形（拖曳、調整大小、修改屬性）
  socket.on('shape:update', (updatedShape) => {
    if (shapes[updatedShape.id]) {
      // 合併新舊資料，確保屬性、類型與房間資訊完整
      shapes[updatedShape.id] = { 
        ...shapes[updatedShape.id], 
        ...updatedShape,
        properties: {
          ...shapes[updatedShape.id].properties,
          ...updatedShape.properties
        }
      };
      io.to(userRoom).emit('shape:updated', shapes[updatedShape.id]);
    }
  });

  // 刪除圖形
  socket.on('shape:remove', (id) => {
    if (shapes[id]) {
      delete shapes[id];
      io.to(userRoom).emit('shape:removed', id);
    }
  });
});

http.listen(3000, () => console.log('伺服器執行於 http://localhost:3000'));
