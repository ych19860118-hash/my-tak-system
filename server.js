const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios'); // 確保 package.json 有安裝 axios

// 放大 JSON 請求主體容量限制
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// 核心記憶體資料庫
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [] }
};
let roomTimers = {}; 

const ADMIN_SECRET = "adminyu"; 

// 快取變數（道路阻斷與 CCTV）
let cachedDisasterData = { data: null, timestamp: 0 };
let cachedCCTVData = { data: null, timestamp: 0 };

// 提供道路阻斷與 CCTV 的代理 API (防止前端 CORS 阻擋)
app.get('/api/road-disaster', async (req, res) => {
    const now = Date.now();
    if (cachedDisasterData.data && (now - cachedDisasterData.timestamp < 300000)) {
        return res.json(cachedDisasterData.data);
    }
    try {
        // 如果還沒有真實 API，請替換成你的來源；若沒有則會安全降級回傳空結構
        const targetUrl = process.env.ROAD_API_URL || 'https://example.com/api/road'; 
        const response = await axios.get(targetUrl, { timeout: 3000 });
        cachedDisasterData = { data: response.data, timestamp: now };
        res.json(response.data);
    } catch (error) {
        // 回傳符合 Leaflet geoJSON 可以解析的空結構
        res.json(cachedDisasterData.data || { type: "FeatureCollection", features: [] });
    }
});

app.get('/api/cctv-list', async (req, res) => {
    const now = Date.now();
    if (cachedCCTVData.data && (now - cachedCCTVData.timestamp < 600000)) {
        return res.json(cachedCCTVData.data);
    }
    try {
        const targetUrl = process.env.CCTV_API_URL || 'https://example.com/api/cctv';
        const response = await axios.get(targetUrl, { timeout: 3000 });
        cachedCCTVData = { data: response.data, timestamp: now };
        res.json(response.data);
    } catch (error) {
        res.json(cachedCCTVData.data || { type: "FeatureCollection", features: [] });
    }
});

app.post('/api/login', (req, res) => {
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
    }

    if (!rooms[rName]) {
        rooms[rName] = { password: roomPassword ? roomPassword.trim() : "", objects: [], events: [] };
    } else {
        if (rooms[rName].password !== "" && rooms[rName].password !== roomPassword.trim()) {
            return res.json({ success: false, message: "登入失敗：該應變房間密碼錯誤！" });
        }
    }

    let isNameTaken = false;
    try {
        const adapter = io.sockets.adapter;
        let roomSockets = adapter && typeof adapter.rooms.get === 'function' ? adapter.rooms.get(rName) : null;
        if (roomSockets) {
            for (const socketId of roomSockets) {
                const clientSocket = io.sockets.sockets.get(socketId);
                if (clientSocket && clientSocket.myName === uName) { isNameTaken = true; break; }
            }
        }
    } catch (e) {}

    if (isNameTaken) {
        return res.json({ success: false, message: `登入失敗：暱稱「${uName}」使用中！` });
    }

    if (roomTimers[rName]) { clearTimeout(roomTimers[rName]); delete roomTimers[rName]; }
    res.json({ success: true, username: uName, roomName: rName });
});

io.on('connection', (socket) => {
    let myRoom = "", myName = "";

    socket.on('join_room', (data) => {
        myRoom = data.roomName; myName = data.username;
        socket.myName = myName; socket.myRoom = myRoom; socket.roomName = myRoom; 
        socket.join(myRoom);

        if (roomTimers[myRoom]) { clearTimeout(roomTimers[myRoom]); delete roomTimers[myRoom]; }

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
        io.to(myRoom).emit('receive_chat', {
            sender: myName, message: messageText.trim(),
            time: new Date().toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Taipei' })
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
            sender: myName, category: eventData.category || '一般回報',
            description: eventData.description || '', lat: eventData.lat, lng: eventData.lng,
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
        const isAdmin = activeName === "管理者[Admin]" || (activeName && activeName.includes('Admin'));
        if (isAdmin || (targetEvent && targetEvent.sender === activeName)) {
            rooms[myRoom].events = rooms[myRoom].events.filter(e => e.id !== eventId);
            io.to(myRoom).emit('event_deleted', eventId);
        }
    });

    socket.on('delete_object', (objectId) => {
        if (!myRoom || !rooms[myRoom]) return;
        const targetObj = rooms[myRoom].objects.find(o => o.id === objectId);
        const activeName = socket.myName || myName;
        const isAdmin = activeName === "管理者[Admin]" || (activeName && activeName.includes('Admin'));
        if (isAdmin || (targetObj && targetObj.creator === activeName)) {
            rooms[myRoom].objects = rooms[myRoom].objects.filter(o => o.id !== objectId);
            io.to(myRoom).emit('object_deleted', objectId);
        }
    });

    socket.on('admin_clear_all', () => {
        const activeName = socket.myName || myName;
        if ((activeName === "管理者[Admin]" || activeName.includes('Admin')) && myRoom && rooms[myRoom]) {
            rooms[myRoom].objects = []; rooms[myRoom].events = []; 
            io.to(myRoom).emit('clear_all_objects');
        }
    });

    socket.on('disconnect', () => {
        if (!myRoom) return;
        if (myName) io.to(myRoom).emit('user_notification', { name: myName, action: 'left' });
        sendUserCount(myRoom);
    });
});

function sendUserCount(roomName) {
    const adapter = io.sockets.adapter;
    let userNames = [], count = 0;
    if (adapter && typeof adapter.rooms.get === 'function') {
        const clients = adapter.rooms.get(roomName);
        count = clients ? clients.size : 0;
        if (clients) {
            for (const socketId of clients) {
                const s = io.sockets.sockets.get(socketId);
                if (s && s.myName) userNames.push(s.myName);
            }
        }
    }
    io.to(roomName).emit('update_user_count', count);
    io.to(roomName).emit('update_user_list', userNames);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`防災協同伺服器已在連接埠 ${PORT} 啟動...`);
});
