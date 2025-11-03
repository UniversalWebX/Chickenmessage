import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let messages = [];
let users = {};

// --- Socket.io logic ---
io.on('connection', (socket) => {
  console.log('[+] User connected', socket.id);

  socket.on('register', (username) => {
    users[socket.id] = username;
    console.log(`[USER] ${username} registered`);
    socket.emit('history', messages);
    io.emit('userList', Object.values(users));
  });

  socket.on('send', (msg) => {
    msg.time = Date.now();
    msg.username = users[socket.id];
    if (!msg.username) return;

    if (msg.type === 'global') {
      messages.push(msg);
      io.emit('message', msg);
    } else if (msg.type === 'dm') {
      const toSock = Object.entries(users).find(([id, name]) => name === msg.to);
      if (toSock) io.to(toSock[0]).emit('message', msg);
      socket.emit('message', msg);
    } else if (msg.type === 'group') {
      msg.to.forEach(u => {
        const target = Object.entries(users).find(([id, name]) => name === u);
        if (target) io.to(target[0]).emit('message', msg);
      });
    }
  });

  socket.on('requestGlobal', () => {
    const globalMsgs = messages.filter(m => m.type === 'global');
    socket.emit('globalHistory', globalMsgs);
  });

  socket.on('adminClearGlobal', () => {
    messages = messages.filter(m => m.type !== 'global');
    io.emit('clearGlobal');
  });

  socket.on('disconnect', () => {
    console.log('[-] Disconnected', socket.id);
    delete users[socket.id];
    io.emit('userList', Object.values(users));
  });
});

// --- API endpoints ---
app.post('/api/announce', (req, res) => {
  const { content } = req.body;
  io.emit('announcement', { content, time: Date.now() });
  res.json({ ok: true });
});

app.post('/api/kick', (req, res) => {
  const { user } = req.body;
  const entry = Object.entries(users).find(([id, name]) => name === user);
  if (entry) {
    io.to(entry[0]).emit('announcement', { content: 'You were kicked by an admin.' });
    io.sockets.sockets.get(entry[0])?.disconnect(true);
    delete users[entry[0]];
    io.emit('userList', Object.values(users));
  }
  res.json({ ok: true });
});

// --- Scheduled job: clear global chat daily at 12 PM PST ---
cron.schedule(
  '0 12 * * *',
  () => {
    console.log('[CRON] Clearing global chat at 12 PM PST');
    messages = messages.filter((m) => m.type !== 'global');
    io.emit('clearGlobal');
  },
  { timezone: 'America/Los_Angeles' }
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
