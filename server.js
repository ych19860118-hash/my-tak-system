const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// 放大 JSON 請求主體容量限制（允許接收較大的圖片 Base64 數據）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));

// 開放本機套件路徑（確保 CSS/JS 同源無阻擋）
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// 核心記憶體資料庫
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [] }
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
            objects: [],
            events: []
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
        socket.roomName = myRoom; 
        
        socket.join(myRoom);

        if (roomTimers[myRoom]) {
            clearTimeout(roomTimers[myRoom]);
            delete roomTimers[myRoom];
        }

        // 登入時同步回傳歷史物件與歷史事件
        socket.emit('history_objects', rooms[myRoom] ? rooms[myRoom].objects : []);
        socket.emit('history_events', rooms[myRoom] ? rooms[myRoom].events : []);

        sendUserCount(myRoom);
        io.to(myRoom).emit('user_notification', { name: myName, action: 'joined' });
    });

    socket.on('share_my_gps', (gpsData) => {
        if (!myRoom) return;
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
        if (!myRoom || !rooms[myRoom]) return;
        rooms[myRoom].objects.push(objData);
        io.to(myRoom).emit('object_added', objData);
    });

    socket.on('new_event', (eventData) => {
        if (!myRoom || !rooms[myRoom]) return;
        
        const enrichedEvent = {
            id: 'evt_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
            sender: myName,
            category: eventData.category || '一般回報',
            description: eventData.description || '',
            lat: eventData.lat,
            lng: eventData.lng,
            photoData: eventData.photoData || null,
            time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
        };

        rooms[myRoom].events.push(enrichedEvent);
        io.to(myRoom).emit('event_added', enrichedEvent);
        console.log(`【新事件回報】房間 ${myRoom} 由 ${myName} 回報：${enrichedEvent.category}`);
    });

    socket.on('delete_event', (eventId) => {
        if (!myRoom || !rooms[myRoom]) return;
        
        const targetEvent = rooms[myRoom].events.find(e => e.id === eventId);
        const activeName = socket.myName || myName;
        const isAdmin = activeName === "管理者[Admin]" || (activeName && activeName.includes('Admin'));
        const isOwner = targetEvent && targetEvent.sender === activeName;

        if (isAdmin || isOwner) {
            rooms[myRoom].events = rooms[myRoom].events.filter(e => e.id !== eventId);
            io.to(myRoom).emit('event_deleted', eventId);
            console.log(`【事件刪除成功】事件 ${eventId} 已由 ${activeName} 刪除`);
        } else {
            console.log(`事件刪除被拒絕：操作者 (${activeName}) 權限不足`);
        }
    });

    socket.on('delete_object', (objectId) => {
        if (!myRoom || !rooms[myRoom]) return;
        const targetObj = rooms[myRoom].objects.find(o => o.id === objectId);
        const activeName = socket.myName || myName;
        const isAdmin = activeName === "管理者[Admin]" || (activeName && activeName.includes('Admin'));
        const isCreator = targetObj && targetObj.creator === activeName;
        
        if (isAdmin || isCreator) {
            rooms[myRoom].objects = rooms[myRoom].objects.filter(o => o.id !== objectId);
            io.to(myRoom).emit('object_deleted', objectId);
            console.log(`【物件刪除成功】物件 ${objectId} 已由 ${activeName} 刪除`);
        } else {
            console.log(`物件刪除被拒絕：操作者 (${activeName}) 權限不足`);
        }
    });

    socket.on('admin_clear_all', () => {
        const activeName = socket.myName || myName;
        const isAdmin = activeName === "管理者[Admin]" || (activeName && activeName.includes('Admin'));
        
        if (isAdmin && myRoom && rooms[myRoom]) {
            rooms[myRoom].objects = [];
            rooms[myRoom].events = []; 
            io.to(myRoom).emit('clear_all_objects');
            console.log(`【緊急清空】房間 ${myRoom} 的所有圖資與事件已由指揮官 ${activeName} 清空`);
        } else {
            console.log(`清空被拒絕：操作者 (${activeName}) 權限不足`);
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
                        rooms[myRoom].events = [];
                    } else {
                        delete rooms[myRoom];
                    }
                    console.log(`應變房間 ${myRoom} 已超過 10 分鐘無人在線，物件與事件已被伺服器自動清空銷毀。`);
                }
                delete roomTimers[myRoom];
            }, 10 * 60 * 1000); 
        }
    });
});

// 💡 修正：同時廣播人數與在線用戶名單陣列
function sendUserCount(roomName) {
    const adapter = io.sockets.adapter;
    let userNames = [];
    let count = 0;
    
    if (adapter && typeof adapter.rooms.get === 'function') {
        const clients = adapter.rooms.get(roomName);
        count = clients ? clients.size : 0;
        if (clients) {
            for (const socketId of clients) {
                const s = io.sockets.sockets.get(socketId);
                if (s && s.myName) userNames.push(s.myName);
            }
        }
    } else if (adapter && adapter.rooms && adapter.rooms[roomName]) {
        const roomSockets = adapter.rooms[roomName];
        count = Object.keys(roomSockets).length;
        for (const socketId of Object.keys(roomSockets)) {
            const s = io.sockets.sockets[socketId];
            if (s && s.myName) userNames.push(s.myName);
        }
    }

    io.to(roomName).emit('update_user_count', count);
    io.to(roomName).emit('update_user_list', userNames); // 傳送具體用戶資訊陣列
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`防災協同伺服器已在連接埠 ${PORT} 啟動...`);
});
