const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 開放本機套件路徑（確保 CSS/JS 同源無阻擋）
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.use('/leaflet-draw', express.static(path.join(__dirname, 'node_modules', 'leaflet-draw', 'dist')));
app.use('/leaflet-draw-images', express.static(path.join(__dirname, 'node_modules', 'leaflet-draw', 'dist', 'images')));

// 核心記憶體資料庫
let rooms = {
    "public_1": { password: "", objects: [] },
    "public_2": { password: "", objects: [] }
};
let roomTimers = {}; // 負責紀錄每個房間的 10 分鐘倒數計時器

// 後端登入與「自動建房」API 路由
app.post('/api/login', (req, res) => {
    const { username, password, roomName, roomPassword } = req.body;
    const rName = roomName ? roomName.trim() : "public_1";

    if (!username || username.trim() === "") {
        return res.json({ success: false, message: "請輸入有效的通報暱稱！" });
    }

    // 如果該房間不存在，則視為使用者自行創建新房間，並鎖定他們設定的房間密碼
    if (!rooms[rName]) {
        rooms[rName] = {
            password: roomPassword ? roomPassword.trim() : "",
            objects: []
        };
    } else {
        // 如果是現有房間，則必須驗證密碼是否符合
        if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword.trim()) {
            return res.json({ success: false, message: "該應變房間密碼錯誤！" });
        }
    }

    // 如果原本正在執行 10 分鐘倒數清除，有人登入代表房間復活，立刻取消計時器
    if (roomTimers[rName]) {
        clearTimeout(roomTimers[rName]);
        delete roomTimers[rName];
    }

    res.json({ success: true, username: username.trim(), roomName: rName });
});

// Socket.io 多人分頻即時通訊大腦
io.on('connection', (socket) => {
    let myRoom = "";
    let myName = "";

    // 監聽加入房間
    socket.on('join_room', (data) => {
        myRoom = data.roomName;
        myName = data.username;
        socket.join(myRoom);

        // 取消該房間的毀滅倒數計時器（安全防護）
        if (roomTimers[myRoom]) {
            clearTimeout(roomTimers[myRoom]);
            delete roomTimers[myRoom];
        }

        // 把該房間的所有歷史舊物件，單獨發送給剛進房的新人
        socket.emit('history_objects', rooms[myRoom] ? rooms[myRoom].objects : []);

        // 即時計算該 Socket 房間內目前有多少人在線上，廣播通知房內全員
        sendUserCount(myRoom);
    });

    // 監聽新增災情
    socket.on('new_object', (objData) => {
        if (rooms[myRoom]) {
            rooms[myRoom].objects.push(objData);
            io.to(myRoom).emit('object_added', objData); // 只廣播給同一個應變房間的人
        }
    });

    // 監聽撤銷/平移災情
    socket.on('delete_object', (objectId) => {
        if (rooms[myRoom]) {
            rooms[myRoom].objects = rooms[myRoom].objects.filter(o => o.id !== objectId);
            io.to(myRoom).emit('object_deleted', objectId);
        }
    });

    // 監聽斷線事件（關鍵：啟動 10 分鐘無人清除計時器）
    socket.on('disconnect', () => {
        if (!myRoom) return;
        
        // 重新更新並廣播該房的人數
        sendUserCount(myRoom);

        // 取得該 Socket 應變房間剩餘的人數
        const clients = io.sockets.adapter.rooms.get(myRoom);
        const currentCount = clients ? clients.size : 0;

        // 💡 如果此時房間空無一人（人數歸零），啟動 10 分鐘毀滅清除計時器！
        if (currentCount === 0) {
            if (roomTimers[myRoom]) clearTimeout(roomTimers[myRoom]);
            
            roomTimers[myRoom] = setTimeout(() => {
                if (rooms[myRoom]) {
                    if (myRoom === "public_1" || myRoom === "public_2") {
                        // 公開房間：只清空裡面的地圖物件
                        rooms[myRoom].objects = [];
                    } else {
                        // 自建專屬私有房間：直接從記憶體內徹底永久抹除
                        delete rooms[myRoom];
                    }
                    console.log(`應變房間 ${myRoom} 已超過 10 分鐘無人在線，物件已被伺服器自動清空。`);
                }
                delete roomTimers[myRoom];
            }, 10 * 60 * 1000); // 10 分鐘 = 600,000 毫秒
        }
    });
});

// 封裝函數：計算並通知同一個應變頻道內部的即時人數
function sendUserCount(roomName) {
    const clients = io.sockets.adapter.rooms.get(roomName);
    const count = clients ? clients.size : 0;
    io.to(roomName).emit('update_user_count', count);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`防災協同伺服器已在連接埠 ${PORT} 啟動...`);
});
