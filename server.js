// server.js
import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import session from "express-session";
import fs from "fs-extra";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

// Files
const usersFile = path.join(__dirname, "users.json");
const messagesFile = path.join(__dirname, "messages.json");
const bansFile = path.join(__dirname, "bans.json");
const siteFile = path.join(__dirname, "site.json");

// Optional GitHub sync (set env GITHUB_TOKEN and GITHUB_REPO like "owner/repo")
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_REPO = process.env.GITHUB_REPO || ""; // example: "darianbayan/mychatrepo"
const GITHUB_PATH = process.env.GITHUB_USERS_PATH || "users.json"; // path in repo to commit

async function ensureFiles(){
  if(!await fs.pathExists(usersFile)) {
    const initialUsers = [{ username: "universalwebx", password: "iliveinanuclearbunker", role: "host" }];
    await fs.writeJSON(usersFile, initialUsers, { spaces: 2 });
  }
  if(!await fs.pathExists(messagesFile)) await fs.writeJSON(messagesFile, [], { spaces: 2 });
  if(!await fs.pathExists(bansFile)) await fs.writeJSON(bansFile, { username: [], ip: [] }, { spaces: 2 });
  if(!await fs.pathExists(siteFile)) await fs.writeJSON(siteFile, { locked: false }, { spaces: 2 });
}
await ensureFiles();

async function readJSON(file){ return fs.readJSON(file); }
async function writeJSON(file, data){ await fs.writeJSON(file, data, { spaces: 2 }); }

// Helper: optionally commit users.json to GitHub (basic, needs GITHUB_TOKEN + GITHUB_REPO)
async function commitUsersToGitHub(){
  if(!GITHUB_TOKEN || !GITHUB_REPO) return;
  try {
    const usersContent = await fs.readFile(usersFile, "utf8");
    const base64 = Buffer.from(usersContent).toString("base64");
    const apiBase = `https://api.github.com/repos/${GITHUB_REPO}/contents/${encodeURIComponent(GITHUB_PATH)}`;

    // Get existing file to obtain sha
    const getRes = await fetch(apiBase, {
      method: "GET",
      headers: { Authorization: `token ${GITHUB_TOKEN}`, "User-Agent": "node" }
    });

    let sha = undefined;
    if (getRes.ok) {
      const getJson = await getRes.json();
      sha = getJson.sha;
    }

    const putRes = await fetch(apiBase, {
      method: "PUT",
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "User-Agent": "node",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "Update users.json (auto-commit)",
        content: base64,
        sha
      })
    });

    if (!putRes.ok) {
      const err = await putRes.text();
      console.warn("GitHub commit failed:", putRes.status, err);
    } else {
      console.log("Committed users.json to GitHub.");
    }
  } catch (e) {
    console.warn("commitUsersToGitHub error:", e.message);
  }
}

// Read helpers
async function getUsers(){ return readJSON(usersFile); }
async function saveUsers(u){ await writeJSON(usersFile, u); await commitUsersToGitHub(); }

async function getMessages(){ return readJSON(messagesFile); }
async function saveMessages(m){ await writeJSON(messagesFile, m); }

async function getBans(){ return readJSON(bansFile); }
async function saveBans(b){ return writeJSON(bansFile, b); }

async function getSite(){ return readJSON(siteFile); }
async function saveSite(s){ return writeJSON(siteFile, s); }

// Middleware and static
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "views")));
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecret-session-key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 }
}));

// --- Auth & Pages ---
app.get("/", (req, res) => {
  if (req.session.username) return res.redirect("/chat");
  res.sendFile(path.join(__dirname, "views/login.html"));
});

app.get("/signup", (req,res) => res.sendFile(path.join(__dirname,"views/signup.html")));

app.post("/signup", async (req, res) => {
  const { username, password } = req.body;
  if(!username || !password) return res.send("Missing fields. <a href='/signup'>Try again</a>");

  const bans = await getBans();
  if (bans.username.find(b => b.name === username && (!b.expires || new Date(b.expires) > new Date()))) {
    return res.send("This account is banned.");
  }

  const users = await getUsers();
  if (users.find(u => u.username === username)) return res.send("Username exists. <a href='/signup'>Try another</a>");

  users.push({ username, password, role: "user" });
  await saveUsers(users);
  res.send("Account created. <a href='/'>Login</a>");
});

app.post("/login", async (req,res) => {
  const ip = req.ip || req.headers["x-forwarded-for"] || req.connection.remoteAddress;
  const { username, password } = req.body;

  const site = await getSite();
  const users = await getUsers();
  const bans = await getBans();

  // site lockdown check (only host/admin allowed to bypass)
  if (site.locked) {
    const candidate = users.find(u => u.username === username && u.password === password);
    if (!(candidate && (candidate.role === "host" || candidate.role === "admin"))) {
      return res.send("Site is currently locked. Login restricted.");
    }
  }

  // check IP ban
  const ipBans = bans.ip || [];
  const ipBan = ipBans.find(b => b.ip === ip && (!b.expires || new Date(b.expires) > new Date()));
  if (ipBan) return res.send("Your IP is banned.");

  // check username ban
  const userBans = bans.username || [];
  const userBan = userBans.find(b => b.name === username && (!b.expires || new Date(b.expires) > new Date()));
  if (userBan) return res.send("This username is banned.");

  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.send("Invalid credentials. <a href='/'>Try again</a>");

  req.session.username = username;
  req.session.role = user.role || "user";
  res.redirect("/chat");
});

app.get("/logout", (req,res) => req.session.destroy(()=>res.redirect("/")));

// API for client to fetch current session username & role
app.get("/me", (req,res) => {
  if (!req.session.username) return res.json({ ok: false });
  return res.json({ ok: true, username: req.session.username, role: req.session.role || "user" });
});

// host/admin page
app.get("/host", async (req,res) => {
  if (!req.session.username) return res.redirect("/");
  const users = await getUsers();
  const me = users.find(u => u.username === req.session.username);
  if (!me || !(me.role === "host" || me.role === "admin")) return res.redirect("/");
  return res.sendFile(path.join(__dirname, "views/host.html"));
});

// Admin actions (POST endpoints)
// All these endpoints require the session user to be host (for sensitive) or admin (for limited ones)
function requireRole(...roles) {
  return async (req,res,next) => {
    if (!req.session.username) return res.status(403).json({ error: "not_logged_in" });
    const users = await getUsers();
    const me = users.find(u => u.username === req.session.username);
    if (!me || !roles.includes(me.role)) return res.status(403).json({ error: "forbidden" });
    req.me = me;
    next();
  };
}

// Ban username (host or admin)
app.post("/api/ban", requireRole("host","admin"), async (req,res) => {
  const { username, durationMinutes } = req.body;
  if (!username) return res.json({ ok:false, error:"missing username" });

  const bans = await getBans();
  const expires = durationMinutes ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
  bans.username = bans.username || [];
  bans.username.push({ name: username, by: req.me.username, expires });
  await saveBans(bans);
  res.json({ ok:true });
});

// IP ban (host only)
app.post("/api/ipban", requireRole("host"), async (req,res) => {
  const { ip, durationMinutes } = req.body;
  if (!ip) return res.json({ ok:false, error:"missing ip" });
  const bans = await getBans();
  const expires = durationMinutes ? new Date(Date.now() + durationMinutes * 60000).toISOString() : null;
  bans.ip = bans.ip || [];
  bans.ip.push({ ip, by: req.me.username, expires });
  await saveBans(bans);
  res.json({ ok:true });
});

// Unban username (host/admin)
app.post("/api/unban", requireRole("host","admin"), async (req,res) => {
  const { username } = req.body;
  const bans = await getBans();
  bans.username = (bans.username || []).filter(b => b.name !== username);
  await saveBans(bans);
  res.json({ ok:true });
});

// Remove IP ban (host only)
app.post("/api/unipban", requireRole("host"), async (req,res) => {
  const { ip } = req.body;
  const bans = await getBans();
  bans.ip = (bans.ip || []).filter(b => b.ip !== ip);
  await saveBans(bans);
  res.json({ ok:true });
});

// Give admin (host only)
app.post("/api/giveadmin", requireRole("host"), async (req,res) => {
  const { username } = req.body;
  const users = await getUsers();
  const u = users.find(x => x.username === username);
  if (!u) return res.json({ ok:false, error:"no user" });
  u.role = "admin";
  await saveUsers(users);
  res.json({ ok:true });
});

// Remove admin (host only)
app.post("/api/removeadmin", requireRole("host"), async (req,res) => {
  const { username } = req.body;
  const users = await getUsers();
  const u = users.find(x => x.username === username);
  if (!u) return res.json({ ok:false, error:"no user" });
  u.role = "user";
  await saveUsers(users);
  res.json({ ok:true });
});

// Site lock/unlock (host only)
app.post("/api/lock", requireRole("host"), async (req,res) => {
  const site = await getSite();
  site.locked = true;
  await saveSite(site);
  res.json({ ok:true });
});
app.post("/api/unlock", requireRole("host"), async (req,res) => {
  const site = await getSite();
  site.locked = false;
  await saveSite(site);
  res.json({ ok:true });
});

// Announcement (host/admin)
app.post("/api/announce", requireRole("host","admin"), async (req,res) => {
  const { content } = req.body;
  if (!content) return res.json({ ok:false, error:"missing content" });

  const msg = { id: Date.now()+"-ann", username: req.me.username, time: new Date().toISOString(), type: "announcement", content };
  const messages = await getMessages();
  messages.push(msg);
  await saveMessages(messages);

  // broadcast to all sockets
  io.emit("message", msg);
  res.json({ ok:true });
});

// API to list users, bans, site state (host/admin)
app.get("/api/state", requireRole("host","admin"), async (req,res) => {
  const users = await getUsers();
  const bans = await getBans();
  const site = await getSite();
  res.json({ ok:true, users, bans, site });
});

// Chat page
app.get("/chat", (req,res) => {
  if(!req.session.username) return res.redirect("/");
  res.sendFile(path.join(__dirname, "views/chat.html"));
});

// Socket.IO
const onlineUsers = new Map(); // socket.id => { username, ip }

io.on("connection", (socket) => {
  let currentUser = null;
  const ip = socket.handshake.address || socket.request.connection.remoteAddress;

  socket.on("identify", async () => {
    // client will call /me and then call identify (no username passed)
    // verify session - we need to map socket -> session username
    // socket.request has no session by default; but we use an easier pattern:
    // clients will call /me and then call identify after receiving username.
    // So server expects username handshake via client 'me' call. We'll accept username.
  });

  // Instead, accept explicit identify with username from client (we trust session)
  socket.on("iam", async (username) => {
    currentUser = username;
    onlineUsers.set(socket.id, { username, ip });

    // send entire history (host/admin see everything; normal users only relevant)
    const messages = await getMessages();
    // filter messages for this user (unless admin/host)
    const users = await getUsers();
    const me = users.find(u => u.username === username);
    const role = me ? me.role : "user";

    if (role === "host" || role === "admin") {
      socket.emit("history", messages);
    } else {
      const filtered = messages.filter(m => {
        if (m.type === "global" || m.type === "announcement") return true;
        if (m.type === "dm") return m.username === username || m.to === username;
        if (m.type === "group") return Array.isArray(m.to) && m.to.includes(username);
        return false;
      });
      socket.emit("history", filtered);
    }
  });

  socket.on("message", async (msg) => {
    // msg: { type: "global"|"dm"|"group"|"announcement", content, to }
    if(!currentUser) return;
    const users = await getUsers();
    const me = users.find(u => u.username === currentUser);
    const role = me ? me.role : "user";

    // check if sender is banned now
    const bans = await getBans();
    const userBan = (bans.username || []).find(b => b.name === currentUser && (!b.expires || new Date(b.expires) > new Date()));
    const ipBan = (bans.ip || []).find(b => b.ip === ip && (!b.expires || new Date(b.expires) > new Date()));
    if (userBan || ipBan) {
      socket.emit("errorMsg", "You are banned.");
      return;
    }

    // site locked check
    const site = await getSite();
    if (site.locked && !(role === "host" || role === "admin")) {
      socket.emit("errorMsg", "Site is locked.");
      return;
    }

    const time = new Date().toISOString();
    const message = { id: Date.now()+"-"+Math.floor(Math.random()*9999), username: currentUser, time, ...msg };

    // persist
    const messages = await getMessages();
    messages.push(message);
    await saveMessages(messages);

    // broadcast according to type and permissions
    for (const [id, s] of io.of("/").sockets) {
      const info = onlineUsers.get(id);
      if (!info) continue;
      const targetUser = info.username;
      // get role for target
      const targetUserObj = (await getUsers()).find(u => u.username === targetUser);
      const targetRole = targetUserObj ? targetUserObj.role : "user";

      let shouldSend = false;

      if (message.type === "global" || message.type === "announcement") shouldSend = true;

      if (message.type === "dm") {
        if (message.username === targetUser || message.to === targetUser) shouldSend = true;
      }

      if (message.type === "group") {
        if (Array.isArray(message.to) && message.to.includes(targetUser)) shouldSend = true;
      }

      // host/admin see everything
      if (targetRole === "host" || targetRole === "admin") shouldSend = true;

      if (shouldSend) {
        s.emit("message", message);
      }
    }
  });

  socket.on("disconnect", () => onlineUsers.delete(socket.id));
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));
