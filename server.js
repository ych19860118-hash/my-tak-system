const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// 靜態檔案目錄，指向您專案中的網頁檔案
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

  // 更新圖形（拖曳、調整大小、修改屬性）安全保護版
  socket.on('shape:update', (updatedShape) => {
    if (!updatedShape || !updatedShape.id) return;

    if (shapes[updatedShape.id]) {
      // 1. 先取得原本儲存的屬性
      const oldProperties = shapes[updatedShape.id].properties || {};
      // 2. 取得前端傳過來的屬性（若無則給空物件，防止展開時噴錯）
      const newProperties = updatedShape.properties || {};

      // 3. 安全合併資料
      shapes[updatedShape.id] = { 
        ...shapes[updatedShape.id], 
        ...updatedShape,
        properties: {
          ...oldProperties,
          ...newProperties
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

// 關鍵修正：相容 Render 雲端平台的動態連接埠設定
const PORT = process.env.PORT || 3000;

http.listen(PORT, () => {
  console.log(`伺服器執行於連接埠 ${PORT}`);
});
