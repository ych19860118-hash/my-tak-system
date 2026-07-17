const express = require('express');
const axios = require('axios');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// 放大請求主體容量限制（支援圖片 Base64 傳輸）
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// 🔐 中央氣象署授權碼與 API 設定
const CWA_API_KEY = "CWA-2E7EC676-1235-48FF-906B-EAB529F3B533";

// 📡 後端氣象資料代理 API（以自動雨量站為例）
app.get('/api/cwa/weather', async (req, res) => {
    try {
        const url = `https://opendata.cwa.gov.tw/api/v1/rest/datastore/O-A0002-001?Authorization=${CWA_API_KEY}`;
        const response = await axios.get(url);
        res.json({ success: true, data: response.data });
    } catch (error) {
        console.error("抓取氣象署資料失敗：", error.message);
        res.status(500).json({ success: false, message: "無法取得氣象署即時資料" });
    }
});

// 核心記憶體資料庫
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [], chatHistory: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [], chatHistory: [] }
};

let chatHistoryBackups = {}; 
let roomTimers = {}; 
const ADMIN_SECRET = "adminyu"; 

app.post('/api/login', async (req, res) => {
    const { username, password, roomName, roomPassword, adminSecret } = req.body;
    const rName = roomName ? roomName.trim() : "公開頻道(風災)";
    let uName = username ? username.trim() : "";

    if (uName === "") {
        return res.json({ success: false, message: "登入失敗：請輸入有效的通報暱稱！" });
    }

    if (uName.toLowerCase() === 'admin') {
        if (!adminSecret || adminSecret.trim() !== ADMIN_SECRET) {
            return res.json({ success: false, message: "登入失敗：管理者身份驗證密鑰錯誤！" });
        }
        uName = "管理者[Admin]";
    } else {
        const lowerName = uName.toLowerCase();
        if (lowerName.includes('admin') || lowerName.includes('管理者')) {
            return res.json({ success: false, message: "登入失敗：非管理員暱稱不得包含 'Admin' 或 '管理者' 字眼！" });
        }
    }

    if (!rooms[rName]) {
        const savedHistory = chatHistoryBackups[rName] || [];
        rooms[rName] = {
            password: roomPassword ? roomPassword.trim() : "",
            objects: [],
            events: [],
            chatHistory: savedHistory 
        };
    } else {
        if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword.trim()) {
            return res.json({ success: false, message: "登入失敗：該應變房間密碼錯誤！" });
        }
    }

    let isNameTaken = false;
    try {
        const sockets = await io.in(rName).fetchSockets();
        for (const s of sockets) {
            if (s.myName === uName) {
                isNameTaken = true;
                break;
            }
        }
    } catch (e) {
        console.log("暱稱查重執行略過...");
    }

    if (isNameTaken) {
        return res.json({ success: false, message: `登入失敗：暱稱「${uName}」正在被使用中！` });
    }

    if (roomTimers[rName]) {
        clearTimeout(roomTimers[rName]);
        delete roomTimers[rName];
    }

    res.json({ success: true, username: uName, roomName: rName });
});

io.on('connection', (socket) => {
    let myRoom = "";
    let myName = "";

    socket.on('join_room', (data) => {
        myRoom = data.roomName;
        myName = data.username;
        socket.myName = myName; 
        socket.myRoom = myRoom;
        socket.join(myRoom);

        if (roomTimers[myRoom]) {
            clearTimeout(roomTimers[myRoom]);
            delete roomTimers[myRoom];
        }

        socket.emit('history_objects', rooms[myRoom] ? rooms[myRoom].objects : []);
        socket.emit('history_events', rooms[myRoom] ? rooms[myRoom].events : []);
        socket.emit('history_chats', rooms[myRoom] && rooms[myRoom].chatHistory ? rooms[myRoom].chatHistory : []);

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
        if (rooms[myRoom]) {
            if (!rooms[myRoom].chatHistory) rooms[myRoom].chatHistory = [];
            rooms[myRoom].chatHistory.push(chatData);
        }
        io.to(myRoom).emit('receive_chat', chatData);
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
    });

    socket.on('delete_event', (eventId) => {
        if (!myRoom || !rooms[myRoom]) return;
        const targetEvent = rooms[myRoom].events.find(e => e.id === eventId);
        const activeName = socket.myName || myName;
        const isAdmin = activeName === "管理者[Admin]";
        const isOwner = targetEvent && targetEvent.sender === activeName;

        if (isAdmin || isOwner) {
            rooms[myRoom].events = rooms[myRoom].events.filter(e => e.id !== eventId);
            io.to(myRoom).emit('event_deleted', eventId);
        }
    });

    socket.on('delete_object', (objectId) => {
        if (!myRoom || !rooms[myRoom]) return;
        const targetObj = rooms[myRoom].objects.find(o => o.id === objectId);
        const activeName = socket.myName || myName;
        const isAdmin = activeName === "管理者[Admin]";
        const isCreator = targetObj && targetObj.creator === activeName;
        
        if (isAdmin || isCreator) {
            rooms[myRoom].objects = rooms[myRoom].objects.filter(o => o.id !== objectId);
            io.to(myRoom).emit('object_deleted', objectId);
        }
    });

    socket.on('admin_clear_all', () => {
        const activeName = socket.myName || myName;
        if (activeName === "管理者[Admin]" && myRoom && rooms[myRoom]) {
            rooms[myRoom].objects = [];
            rooms[myRoom].events = []; 
            rooms[myRoom].chatHistory = []; 
            io.to(myRoom).emit('clear_all_objects');
        }
    });

    socket.on('disconnect', async () => {
        if (!myRoom) return;
        if (myName) io.to(myRoom).emit('user_notification', { name: myName, action: 'left' });
        sendUserCount(myRoom);

        const sockets = await io.in(myRoom).fetchSockets();
        if (sockets.length === 0) {
            if (roomTimers[myRoom]) clearTimeout(roomTimers[myRoom]);
            roomTimers[myRoom] = setTimeout(() => {
                if (rooms[myRoom]) {
                    if (rooms[myRoom].chatHistory?.length > 0) {
                        chatHistoryBackups[myRoom] = rooms[myRoom].chatHistory;
                    }
                    if (myRoom === "公開頻道(風災)" || myRoom === "公開頻道(震災)") {
                        rooms[myRoom].objects = [];
                        rooms[myRoom].events = [];
                    } else {
                        delete rooms[myRoom];
                    }
                }
                delete roomTimers[myRoom];
            }, 8 * 60 * 60 * 1000); 
        }
    });
});

async function sendUserCount(roomName) {
    try {
        const sockets = await io.in(roomName).fetchSockets();
        io.to(roomName).emit('update_user_count', sockets.length);
        io.to(roomName).emit('update_user_list', sockets.map(s => s.myName).filter(Boolean));
    } catch (e) {}
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`伺服器執行於 Port ${PORT}`);
});
