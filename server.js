// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";
import session from "express-session";
import fs from "fs-extra";
import path from "path";
import cron from "node-cron";
import bodyParser from "body-parser";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const ROOT = process.cwd();
const VIEWS = path.join(ROOT, "views");
const USERS_FILE = path.join(ROOT, "users.json");
const MESSAGES_FILE = path.join(ROOT, "messages.json");
const BANS_FILE = path.join(ROOT, "bans.json");
const SITE_FILE = path.join(ROOT, "site.json");

async function ensureFiles() {
  if (!fs.pathExistsSync(USERS_FILE)) {
    await fs.writeJson(USERS_FILE, {
      "universalwebx": { "password": "iliveinanuclearbunker", "role": "host" }
    }, { spaces: 2 });
  }
  if (!fs.pathExistsSync(MESSAGES_FILE)) await fs.writeJson(MESSAGES_FILE, [], { spaces: 2 });
  if (!fs.pathExistsSync(BANS_FILE)) await fs.writeJson(BANS_FILE, { username: [], ip: [] }, { spaces: 2 });
  if (!fs.pathExistsSync(SITE_FILE)) await fs.writeJson(SITE_FILE, { locked: false }, { spaces: 2 });
}
await ensureFiles();

const read = async (p) => fs.readJson(p);
const write = async (p, d) => fs.writeJson(p, d, { spaces: 2 });

app.use(bodyParser.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "chicken-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

// Serve static views folder
app.use(express.static(VIEWS));

// Routes (serve HTML from views)
app.get("/", (req, res) => {
  if (req.session.username) return res.redirect("/chat.html");
  return res.sendFile(path.join(VIEWS, "login.html"));
});
app.get("/login", (req, res) => res.sendFile(path.join(VIEWS, "login.html")));
app.get("/signup", (req, res) => res.sendFile(path.join(VIEWS, "signup.html")));
app.get("/chat", (req, res) => {
  if (!req.session.username) return res.redirect("/");
  return res.sendFile(path.join(VIEWS, "chat.html"));
});
app.get("/host", (req, res) => {
  if (!req.session.username) return res.redirect("/");
  return res.sendFile(path.join(VIEWS, "host.html"));
});
app.get("/me", (req, res) => {
  if (!req.session.username) return res.json({ ok: false });
  return res.json({ ok: true, username: req.session.username, role: req.session.role || "user" });
});

// Signup
app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.json({ ok: false, error: "missing" });
  const users = await read(USERS_FILE);
  if (users[username]) return res.json({ ok: false, error: "exists" });

  const bans = await read(BANS_FILE);
  const userBan = (bans.username || []).find(b => b.name === username && (!b.expires || new Date(b.expires) > new Date()));
  if (userBan) return res.json({ ok: false, error: "banned" });

  users[username] = { password, role: "user" };
  await write(USERS_FILE, users);

  req.session.username = username;
  req.session.role = "user";
  return res.json({ ok: true });
});

// Login
app.post("/login", async (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  const { username, password } = req.body;
  const users = await read(USERS_FILE);
  const user = users[username];
  if (!user || user.password !== password) return res.json({ ok: false, error: "invalid" });

  const site = await read(SITE_FILE);
  if (site.locked && !(user.role === "host" || user.role === "admin")) return res.json({ ok: false, error: "locked" });

  const bans = await read(BANS_FILE);
  const ipBan = (bans.ip || []).find(b => b.ip === ip && (!b.expires || new Date(b.expires) > new Date()));
  if (ipBan) return res.json({ ok: false, error: "ipbanned" });
  const userBan = (bans.username || []).find(b => b.name === username && (!b.expires || new Date(b.expires) > new Date()));
  if (userBan) return res.json({ ok: false, error: "userbanned" });

  req.session.username = username;
  req.session.role = user.role || "user";
  return res.json({ ok: true, role: req.session.role });
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Role-check middleware
const requireRole = (...roles) => async (req, res, next) => {
  if (!req.session.username) return res.status(403).json({ ok: false, error: "notlogged" });
  const users = await read(USERS_FILE);
  const me = users[req.session.username];
  if (!me || !roles.includes(me.role)) return res.status(403).json({ ok: false, error: "forbidden" });
  req.me = me;
  next();
};

// Admin APIs
app.post("/api/announce", requireRole("host", "admin"), async (req, res) => {
  const { content } = req.body;
  if (!content) return res.json({ ok: false, error: "missing" });
  io.emit("announcement", { content, time: Date.now() });
  return res.json({ ok: true });
});

app.post("/api/ban", requireRole("host", "admin"), async (req, res) => {
  const { username, durationMinutes } = req.body;
  if (!username) return res.json({ ok: false, error: "missing" });
  const bans = await read(BANS_FILE);
  const expires = durationMinutes ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
  bans.username = bans.username || [];
  bans.username.push({ name: username, by: req.me.username, expires });
  await write(BANS_FILE, bans);
  return res.json({ ok: true });
});

app.post("/api/unban", requireRole("host", "admin"), async (req, res) => {
  const { username } = req.body;
  const bans = await read(BANS_FILE);
  bans.username = (bans.username || []).filter(b => b.name !== username);
  await write(BANS_FILE, bans);
  return res.json({ ok: true });
});

app.post("/api/ipban", requireRole("host"), async (req, res) => {
  const { ip, durationMinutes } = req.body;
  if (!ip) return res.json({ ok: false, error: "missing" });
  const bans = await read(BANS_FILE);
  const expires = durationMinutes ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
  bans.ip = bans.ip || [];
  bans.ip.push({ ip, by: req.me.username, expires });
  await write(BANS_FILE, bans);
  return res.json({ ok: true });
});

app.post("/api/unipban", requireRole("host"), async (req, res) => {
  const { ip } = req.body;
  const bans = await read(BANS_FILE);
  bans.ip = (bans.ip || []).filter(b => b.ip !== ip);
  await write(BANS_FILE, bans);
  return res.json({ ok: true });
});

app.post("/api/giveadmin", requireRole("host"), async (req, res) => {
  const { username } = req.body;
  const users = await read(USERS_FILE);
  if (!users[username]) return res.json({ ok: false, error: "nouser" });
  users[username].role = "admin";
  await write(USERS_FILE, users);
  return res.json({ ok: true });
});

app.post("/api/removeadmin", requireRole("host"), async (req, res) => {
  const { username } = req.body;
  const users = await read(USERS_FILE);
  if (!users[username]) return res.json({ ok: false, error: "nouser" });
  users[username].role = "user";
  await write(USERS_FILE, users);
  return res.json({ ok: true });
});

app.post("/api/lock", requireRole("host"), async (req, res) => {
  const site = await read(SITE_FILE);
  site.locked = true;
  await write(SITE_FILE, site);
  return res.json({ ok: true });
});

app.post("/api/unlock", requireRole("host"), async (req, res) => {
  const site = await read(SITE_FILE);
  site.locked = false;
  await write(SITE_FILE, site);
  return res.json({ ok: true });
});

app.post("/api/kick", requireRole("host", "admin"), async (req, res) => {
  const { user } = req.body;
  // server-side kick via socket: emit kick to that username; socket listeners will disconnect
  io.emit("serverKick", { user });
  return res.json({ ok: true });
});

// Socket.IO realtime
const online = new Map();
let messages = await read(MESSAGES_FILE);

io.on("connection", (socket) => {
  const ip = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;

  socket.on("register", async (username) => {
    socket.data.username = username;
    online.set(socket.id, { username, ip });

    messages = await read(MESSAGES_FILE);
    const usersObj = await read(USERS_FILE);
    const me = usersObj[username] || { role: "user" };

    if (me.role === "host" || me.role === "admin") {
      socket.emit("history", messages);
    } else {
      const filtered = messages.filter(m => {
        if (m.type === "global") return true;
        if (m.type === "dm") return m.username === username || m.to === username;
        if (m.type === "group") return Array.isArray(m.to) && m.to.includes(username);
        return false;
      });
      socket.emit("history", filtered);
    }

    io.emit("userList", Array.from(online.values()).map(o => o.username));
  });

  socket.on("send", async (payload) => {
    const username = socket.data.username;
    if (!username) return;
    const usersObj = await read(USERS_FILE);
    const me = usersObj[username] || { role: "user" };
    const bans = await read(BANS_FILE);
    const userBan = (bans.username || []).find(b => b.name === username && (!b.expires || new Date(b.expires) > new Date()));
    const ipBan = (bans.ip || []).find(b => b.ip === ip && (!b.expires || new Date(b.expires) > new Date()));
    if (userBan || ipBan) {
      socket.emit("announcement", { content: "You are banned." });
      return;
    }
    const site = await read(SITE_FILE);
    if (site.locked && !(me.role === "host" || me.role === "admin")) {
      socket.emit("announcement", { content: "Site is locked." });
      return;
    }

    const time = new Date().toISOString();
    const message = { id: Date.now() + "-" + Math.floor(Math.random() * 9999), username, time, ...payload };

    // persist message
    messages.push(message);
    await write(MESSAGES_FILE, messages);

    // broadcast rules
    const usersFile = await read(USERS_FILE);
    for (const [id, s] of io.of("/").sockets) {
      const info = online.get(id);
      if (!info) continue;
      const target = info.username;
      const targetRole = usersFile[target] ? usersFile[target].role : "user";
      let send = false;

      if (message.type === "global") send = true;
      if (message.type === "dm") {
        if (message.username === target || message.to === target) send = true;
      }
      if (message.type === "group") {
        if (Array.isArray(message.to) && message.to.includes(target)) send = true;
      }
      if (targetRole === "host" || targetRole === "admin") send = true;

      if (send) io.to(id).emit("message", message);
    }
  });

  socket.on("requestGlobal", async () => {
    const globalMsgs = (await read(MESSAGES_FILE)).filter(m => m.type === "global");
    socket.emit("globalHistory", globalMsgs);
  });

  socket.on("adminClearGlobal", async () => {
    const username = socket.data.username;
    const usersObj = await read(USERS_FILE);
    const me = usersObj[username] || {};
    if (!me || !(me.role === "host" || me.role === "admin")) {
      socket.emit("announcement", { content: "Permission denied." });
      return;
    }
    messages = messages.filter(m => m.type !== "global");
    await write(MESSAGES_FILE, messages);
    io.emit("clearGlobal");
  });

  socket.on("disconnect", () => {
    online.delete(socket.id);
    io.emit("userList", Array.from(online.values()).map(o => o.username));
  });

  // server-side kick: disconnect matching socket(s)
  socket.on("serverKickRequest", async (data) => {
    const usersObj = await read(USERS_FILE);
    const me = usersObj[socket.data.username] || {};
    if (!(me.role === "host" || me.role === "admin")) return;
    const targetUser = data.user;
    for (const [id, info] of online.entries()) {
      if (info.username === targetUser) {
        io.to(id).emit("announcement", { content: "You were kicked by an admin." });
        io.sockets.sockets.get(id)?.disconnect(true);
      }
    }
  });
});

// Cron job to clear global chat at 12:00 PM PST daily
cron.schedule("0 12 * * *", async () => {
  console.log("[CRON] Clearing global chat at 12:00 PM PST");
  messages = (await read(MESSAGES_FILE)).filter(m => m.type !== "global");
  await write(MESSAGES_FILE, messages);
  io.emit("clearGlobal");
}, { timezone: "America/Los_Angeles" });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
