const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 開放本機套件路徑（確保 CSS/JS 同源無阻擋）
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// 核心記憶體資料庫
let rooms = {
    "public_1": { password: "", objects: [] },
    "public_2": { password: "", objects: [] }
};
let roomTimers = {}; // 負責紀錄每個房間的 10 分鐘倒數計時器

// === 核心功能：相容新舊版 Socket.io，房內沒人時 100% 綠燈放行進房 ===
app.post('/api/login', (req, res) => {
    const { username, password, roomName, roomPassword } = req.body;
    const rName = roomName ? roomName.trim() : "public_1";
    const uName = username ? username.trim() : "";

    if (uName === "") {
        return res.json({ success: false, message: "登入失敗：請輸入有效的通報暱稱！" });
    }

    // 1. 如果是新房間，直接初始化
    if (!rooms[rName]) {
        rooms[rName] = {
            password: roomPassword ? roomPassword.trim() : "",
            objects: []
        };
    } else {
        // 2. 如果是現有房間，先驗證管理密碼是否正確
        if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword.trim()) {
            return res.json({ success: false, message: "登入失敗：該應變房間密碼錯誤！" });
        }
    }

    // 檢查：當頻道沒人時，100% 放行，絕不誤判攔截第一個進房的人
    let isNameTaken = false;
    try {
        const adapter = io.sockets.adapter;
        let roomSockets = null;
        
        if (adapter && typeof adapter.rooms.get === 'function') {
            roomSockets = adapter.rooms.get(rName); // 新版 Socket.io
        } else if (adapter && adapter.rooms) {
            roomSockets = adapter.rooms[rName]; // 舊版 Socket.io
        }

        // 只有在應變頻道存在、且內部有連線人員時才執行人名查重比對
        if (roomSockets) {
            const socketIds = typeof roomSockets.forEach === 'function' ? roomSockets : Object.keys(roomSockets);
            
            // 防呆判定：確認房內 Socket 數大於 0 才比對，空房直接跳過（安全放行）
            if (socketIds && (socketIds.size > 0 || socketIds.length > 0)) {
                for (const socketId of socketIds) {
                    const clientSocket = io.sockets.sockets.get ? io.sockets.sockets.get(socketId) : io.sockets.sockets[socketId];
                    if (clientSocket && clientSocket.myName === uName) {
                        isNameTaken = true;
                        break;
                    }
                }
            }
        }
    } catch (e) {
        console.log("暱稱查重執行時發生跳過，安全放行中...");
    }

    if (isNameTaken) {
        return res.json({ 
            success: false, 
            message: `登入失敗：暱稱「${uName}」目前正被房內其他在線人員使用中，請換一個名字！` 
        });
    }

    // 3. 取消該房的無人自毀倒數
    if (roomTimers[rName]) {
        clearTimeout(roomTimers[rName]);
        delete roomTimers[rName];
    }

    res.json({ success: true, username: uName, roomName: rName });
});

// Socket.io 多人分頻即時通訊大腦
io.on('connection', (socket) => {
    let myRoom = "";
    let myName = "";

    // 監聽加入房間
    socket.on('join_room', (data) => {
        myRoom = data.roomName;
        myName = data.username;
        
        // 💡 關鍵綁定：寫入連線實例中，方便上方的 API 路由與動態 GPS 追蹤機制精準查重
        socket.myName = myName; 
        socket.myRoom = myRoom;
        
        socket.join(myRoom);

        // 取消倒數計時
        if (roomTimers[myRoom]) {
            clearTimeout(roomTimers[myRoom]);
            delete roomTimers[myRoom];
        }

        // 發送歷史舊物件
        socket.emit('history_objects', rooms[myRoom] ? rooms[myRoom].objects : []);

        // 廣播即時在線人數與進場通知
        sendUserCount(myRoom);
        io.to(myRoom).emit('user_notification', { name: myName, action: 'joined' });
    });

    // 💡【最新功能】：監聽前方回報隊員發送的即時 GPS，並動態轉發給同個應變頻道內的所有人
    socket.on('share_my_gps', (gpsData) => {
        gpsData.username = myName; // 塞入該使用者的 OPERATOR ID
        socket.to(myRoom).emit('peer_gps_updated', gpsData); // 轉發廣播給房間內的其他隊員
    });

    // 監聽新增災情
    socket.on('new_object', (objData) => {
        if (rooms[myRoom]) {
            rooms[myRoom].objects.push(objData);
            io.to(myRoom).emit('object_added', objData);
        }
    });

    // 監聽撤銷/平移災情（加入管理員權限判定：若為 admin 則強制允許刪除任意物件）
    socket.on('delete_object', (objectId) => {
        if (rooms[myRoom]) {
            // 檢查是否為 admin 或是該物件的建立者（若您的物件資料有紀錄 sender / username）
            const targetObj = rooms[myRoom].objects.find(o => o.id === objectId);
            const isAdmin = (myName === 'admin');
            
            if (isAdmin || (targetObj && targetObj.username === myName)) {
                rooms[myRoom].objects = rooms[myRoom].objects.filter(o => o.id !== objectId);
                io.to(myRoom).emit('object_deleted', objectId);
            }
        }
    });

    // 監聽斷線事件（啟動 10 分鐘無人清除計時器）
    socket.on('disconnect', () => {
        if (!myRoom) return;
        
        // 廣播離開通知
        if (myName) {
            io.to(myRoom).emit('user_notification', { name: myName, action: 'left' });
        }
        
        sendUserCount(myRoom);

        const adapter = io.sockets.adapter;
        let currentCount = 0;
        if (adapter && typeof adapter.rooms.get === 'function') {
            const clients = adapter.rooms.get(myRoom);
            currentCount = clients ? clients.size : 0;
        } else if (adapter && adapter.rooms && adapter.rooms[myRoom]) {
            currentCount = Object.keys(adapter.rooms[myRoom]).length;
        }

        // 如果房間完全空無一人，啟動 10 分鐘毀滅清除計時器！
        if (currentCount === 0) {
            if (roomTimers[myRoom]) clearTimeout(roomTimers[myRoom]);
            
            roomTimers[myRoom] = setTimeout(() => {
                if (rooms[myRoom]) {
                    if (myRoom === "public_1" || myRoom === "public_2") {
                        rooms[myRoom].objects = [];
                    } else {
                        delete rooms[myRoom];
                    }
                    console.log(`應變房間 ${myRoom} 已超過 10 分鐘無人在線，物件已被伺服器自動清空銷毀。`);
                }
                delete roomTimers[myRoom];
            }, 10 * 60 * 1000); 
        }
    });
});

// 封裝函數：計算並廣播即時線上人數
function sendUserCount(roomName) {
    const adapter = io.sockets.adapter;
    let count = 0;
    if (adapter && typeof adapter.rooms.get === 'function') {
        const clients = adapter.rooms.get(roomName);
        count = clients ? clients.size : 0;
    } else if (adapter && adapter.rooms && adapter.rooms[roomName]) {
        count = Object.keys(adapter.rooms[roomName]).length;
    }
    io.to(roomName).emit('update_user_count', count);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`防災協同伺服器已在連接埠 ${PORT} 啟動...`);
});
