const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const axios = require('axios'); // 💡 已新增：用於氣象 API 請求

// 放大 JSON 請求主體容量限制
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

app.use(express.static(path.join(__dirname, 'public')));
app.use('/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));

// 核心記憶體資料庫
let rooms = {
    "公開頻道(風災)": { password: "", objects: [], events: [], chatHistory: [] }, 
    "公開頻道(震災)": { password: "", objects: [], events: [], chatHistory: [] }
};

let chatHistoryBackups = {}; 
let roomTimers = {}; 
const ADMIN_SECRET = "adminyu"; 

// --- 💡 新增：氣象資料定時推播任務 ---
async function broadcastWeatherUpdate() {
    try {
        // 請將下方的 URL 替換為實際的氣象 API 端點
        const response = await axios.get('https://您的氣象API位址'); 
        const weatherData = response.data;
        
        // 推播給所有房間的用戶
        Object.keys(rooms).forEach(roomName => {
            io.to(roomName).emit('weather_update', weatherData);
        });
    } catch (error) {
        console.error("氣象資料抓取失敗:", error.message);
    }
}
// 每 10 分鐘執行一次
setInterval(broadcastWeatherUpdate, 10 * 60 * 1000);
// ------------------------------------

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
        console.log("暱稱查重發生錯誤，安全放行...");
    }

    if (isNameTaken) {
        return res.json({ success: false, message: `登入失敗：暱稱「${uName}」已被使用！` });
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

    // ... 其他 socket 事件 (send_chat, new_object, new_event 等維持不變) ...
    // [省略部分重複程式碼以節省篇幅，請保留您原有的內容]

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
                    
                    // 💡 已修正：保護核心頻道，僅清空資料不刪除房間
                    if (myRoom === "公開頻道(風災)" || myRoom === "公開頻道(震災)") {
                        rooms[myRoom].objects = [];
                        rooms[myRoom].events = [];
                        console.log(`[核心頻道清理] ${myRoom} 已清空以釋放記憶體。`);
                    } else {
                        delete rooms[myRoom];
                        console.log(`[自動銷毀] 自訂房間 ${myRoom} 已刪除。`);
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
    } catch (e) {
        console.error("更新用戶數量錯誤:", e);
    }
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`防災協同伺服器啟動於 ${PORT}...`);
});
