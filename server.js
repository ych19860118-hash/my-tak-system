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
    "公開頻道(風災)": { password: "", objects: [] },
    "公開頻道(震災)": { password: "", objects: [] }
};
let roomTimers = {}; // 負責紀錄每個房間的 10 分鐘倒數計時器

// 🔐 定義最高指揮官專屬密鑰
const ADMIN_SECRET = "adminyu"; 

app.post('/api/login', (req, res) => {
    const { username, password, roomName, roomPassword, adminSecret } = req.body;
    const rName = roomName ? roomName.trim() : "公開頻道(風災)";
    let uName = username ? username.trim() : "";

    if (uName === "") {
        return res.json({ success: false, message: "登入失敗：請輸入有效的通報暱稱！" });
    }

    // 🔐 管理員身份嚴格驗證
    if (uName.toLowerCase() === 'admin') {
        if (!adminSecret || adminSecret.trim() !== ADMIN_SECRET) {
            return res.json({ success: false, message: "登入失敗：管理者身份驗證密鑰錯誤！" });
        }
        uName = "管理者[Admin]";
    }

    if (!rooms[rName]) {
        rooms[rName] = {
            password: roomPassword ? roomPassword.trim() : "",
            objects: []
        };
    } else {
        if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword.trim()) {
            return res.json({ success: false, message: "登入失敗：該應變房間密碼錯誤！" });
        }
    }

    let isNameTaken = false;
    try {
        const adapter = io.sockets.adapter;
        let roomSockets = null;
        
        if (adapter && typeof adapter.rooms.get === 'function') {
            roomSockets = adapter.rooms.get(rName); 
        } else if (adapter && adapter.rooms) {
            roomSockets = adapter.rooms[rName]; 
        }

        if (roomSockets) {
            const socketIds = typeof roomSockets.forEach === 'function' ? roomSockets : Object.keys(roomSockets);
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

    socket.on('join_room', (data) => {
        myRoom = data.roomName;
        myName = data.username;
        
        socket.myName = myName; 
        socket.myRoom = myRoom;
        socket.roomName = myRoom; // 綁定 roomName 屬性供 broadcast 使用
        
        socket.join(myRoom);

        if (roomTimers[myRoom]) {
            clearTimeout(roomTimers[myRoom]);
            delete roomTimers[myRoom];
        }

        socket.emit('history_objects', rooms[myRoom] ? rooms[myRoom].objects : []);

        sendUserCount(myRoom);
        io.to(myRoom).emit('user_notification', { name: myName, action: 'joined' });
    });

    socket.on('share_my_gps', (gpsData) => {
        gpsData.username = myName; 
        socket.to(myRoom).emit('peer_gps_updated', gpsData); 
    });

    socket.on('send_chat', (messageText) => {
        if (!myRoom || !myName || !messageText.trim()) return;
        const chatData = {
            sender: myName,
            message: messageText.trim(),
            time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
        };
        io.to(myRoom).emit('receive_chat', chatData);
    });

    // 📷 接收並廣播其他用戶分享的照片/影片檔
    socket.on('share_media', (data) => {
        if (!myRoom || !myName) return;
        io.to(myRoom).emit('receive_media', {
            sender: myName,
            mediaType: data.mediaType,
            mediaData: data.mediaData,
            fileName: data.fileName
        });
    });

    socket.on('new_object', (objData) => {
        if (rooms[myRoom]) {
            rooms[myRoom].objects.push(objData);
            io.to(myRoom).emit('object_added', objData);
        }
    });

    socket.on('delete_object', (objectId) => {
        if (rooms[myRoom]) {
            const targetObj = rooms[myRoom].objects.find(o => o.id === objectId);
            const isAdmin = (myName.includes('[Admin]'));
            
            if (isAdmin || (targetObj && targetObj.creator === myName)) {
                rooms[myRoom].objects = rooms[myRoom].objects.filter(o => o.id !== objectId);
                io.to(myRoom).emit('object_deleted', objectId);
            }
        }
    });

    socket.on('disconnect', () => {
        if (!myRoom) return;
        
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

        if (currentCount === 0) {
            if (roomTimers[myRoom]) clearTimeout(roomTimers[myRoom]);
            
            roomTimers[myRoom] = setTimeout(() => {
                if (rooms[myRoom]) {
                    if (myRoom === "公開頻道(風災)" || myRoom === "公開頻道(震災)") {
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
