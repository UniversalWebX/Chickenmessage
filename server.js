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

// Ensure files exist and create default host user
async function ensureFiles() {
  if (!await fs.pathExists(usersFile)) {
    const initialUsers = [
      {
        username: "universalwebx",
        password: "iliveinanuclearbunker",
        role: "host"
      }
    ];
    await fs.writeJSON(usersFile, initialUsers, { spaces: 2 });
    console.log("Created users.json with host account.");
  }
  if (!await fs.pathExists(messagesFile)) {
    await fs.writeJSON(messagesFile, [], { spaces: 2 });
    console.log("Created messages.json");
  }
}
await ensureFiles();

async function readUsers(){ return fs.readJSON(usersFile); }
async function saveUsers(u){ return fs.writeJSON(usersFile, u, { spaces: 2 }); }
async function readMessages(){ return fs.readJSON(messagesFile); }
async function saveMessages(m){ return fs.writeJSON(messagesFile, m, { spaces: 2 }); }

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "views")));
const sess = session({
  secret: "supersecret-session-key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
});
app.use(sess);

// Routes
app.get("/", (req, res) => {
  if (req.session.role === "host") return res.redirect("/host");
  if (req.session.role === "user") return res.redirect("/chat");
  res.sendFile(path.join(__dirname, "views/login.html"));
});

app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "views/signup.html"));
});

app.post("/signup", async (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password || !role) return res.send("Missing fields. <a href='/signup'>Try again</a>");
  const users = await readUsers();
  if (users.find(u => u.username === username)) return res.send("Username exists. <a href='/signup'>Try another</a>");
  users.push({ username, password, role });
  await saveUsers(users);
  res.send("Account created. <a href='/'>Login</a>");
});

app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const users = await readUsers();
  const user = users.find(u => u.username === username && u.password === password);
  if (!user) return res.send("Invalid credentials. <a href='/'>Try again</a>");
  req.session.username = user.username;
  req.session.role = user.role;
  if (user.role === "host") return res.redirect("/host");
  return res.redirect("/chat");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Host page (admin)
app.get("/host", async (req, res) => {
  if (req.session.role !== "host") return res.redirect("/");
  // send a generated host page embedding username+role
  const html = generateHostHTML(req.session.username);
  res.send(html);
});

// User chat page
app.get("/chat", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");
  const html = generateUserHTML(req.session.username);
  res.send(html);
});

// Simple API for host to fetch messages (optional)
app.get("/api/messages", async (req, res) => {
  if (req.session.role !== "host") return res.status(403).json({ error: "forbidden" });
  const messages = await readMessages();
  res.json(messages);
});

// Socket.IO realtime
io.on("connection", (socket) => {
  // clients will emit 'identify' immediately with { username, role }
  socket.on("identify", async (payload) => {
    const { username, role } = payload || {};
    socket.data.username = username;
    socket.data.role = role;

    // If host connected, give them full history
    if (role === "host") {
      const all = await readMessages();
      socket.emit("history", all);
    } else {
      // for normal user, send only their own messages (persisted)
      const all = await readMessages();
      const own = all.filter(m => m.username === username);
      socket.emit("history", own);
    }
  });

  socket.on("message", async (msgText) => {
    const username = socket.data.username || "unknown";
    const time = new Date().toISOString();
    const message = { id: Date.now() + "-" + Math.floor(Math.random()*9999), username, text: String(msgText), time };

    // persist
    const messages = await readMessages();
    messages.push(message);
    await saveMessages(messages);

    // send message to host sockets (all hosts)
    for (const [id, s] of io.of("/").sockets) {
      if (s.data.role === "host") s.emit("message", message);
    }

    // send to the sender only (so users only see their messages)
    socket.emit("message", message);
  });

  socket.on("disconnect", () => {
    // nothing special
  });
});

// Helpers to produce pages with username injection
function generateUserHTML(username){
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Chat — ${username}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="win12">
  <div class="window chat-window">
    <div class="titlebar">
      <div class="title">Win12 Chat — User</div>
      <div class="actions">
        <a href="/logout" class="btn tiny">Logout</a>
      </div>
    </div>

    <div class="content">
      <div id="messages" class="messages"></div>

      <form id="form" class="input-row">
        <input id="input" autocomplete="off" placeholder="Type a message..." />
        <button>Send</button>
      </form>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const username = ${JSON.stringify(username)};
  const role = "user";
  const socket = io();
  socket.emit('identify', { username, role });

  const messagesEl = document.getElementById('messages');
  const form = document.getElementById('form');
  const input = document.getElementById('input');

  function addMessage(m){
    const el = document.createElement('div');
    el.className = 'msg';
    el.innerHTML = '<div class="meta"><strong>' + m.username + '</strong> <span class="time">' + new Date(m.time).toLocaleString() + '</span></div><div class="text">' + escapeHtml(m.text) + '</div>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  socket.on('history', msgs => {
    messagesEl.innerHTML = '';
    msgs.forEach(addMessage);
  });

  socket.on('message', m => {
    addMessage(m);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const txt = input.value.trim();
    if (!txt) return;
    socket.emit('message', txt);
    input.value = '';
  });

  function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
</script>
</body>
</html>`;
}

function generateHostHTML(username){
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Host Dashboard — ${username}</title>
<link rel="stylesheet" href="/styles.css">
</head>
<body class="win12">
  <div class="window host-window">
    <div class="titlebar">
      <div class="title">Win12 Host Dashboard</div>
      <div class="actions">
        <a href="/logout" class="btn tiny">Logout</a>
      </div>
    </div>

    <div class="content host-content">
      <div class="left">
        <h3>All messages</h3>
        <div id="messages" class="messages"></div>
      </div>
      <div class="right">
        <h3>Controls</h3>
        <div>
          <button id="refresh">Reload history</button>
        </div>
        <h4>Quick users list</h4>
        <div id="usersList">—</div>
      </div>
    </div>
  </div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const username = ${JSON.stringify(username)};
  const role = "host";
  const socket = io();
  socket.emit('identify', { username, role });

  const messagesEl = document.getElementById('messages');
  const usersListEl = document.getElementById('usersList');

  function addMessage(m){
    const el = document.createElement('div');
    el.className = 'msg host';
    el.innerHTML = '<div class="meta"><strong>' + m.username + '</strong> <span class="time">' + new Date(m.time).toLocaleString() + '</span></div><div class="text">' + escapeHtml(m.text) + '</div>';
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  socket.on('history', msgs => {
    messagesEl.innerHTML = '';
    msgs.forEach(addMessage);
    updateUsersList(msgs);
  });

  socket.on('message', m => {
    addMessage(m);
    updateUsersList([m], true);
  });

  document.getElementById('refresh').addEventListener('click', async () => {
    const res = await fetch('/api/messages');
    const data = await res.json();
    messagesEl.innerHTML = '';
    data.forEach(addMessage);
    updateUsersList(data);
  });

  function updateUsersList(msgs, append=false){
    const users = new Set();
    msgs.forEach(m => users.add(m.username));
    if (append) {
      // keep existing plus new ones
      const cur = new Set(Array.from(usersListEl.querySelectorAll('div')).map(d => d.textContent));
      for (const u of users) cur.add(u);
      usersListEl.innerHTML = Array.from(cur).map(u => '<div>' + escapeHtml(u) + '</div>').join('');
    } else {
      usersListEl.innerHTML = Array.from(users).map(u => '<div>' + escapeHtml(u) + '</div>').join('') || '—';
    }
  }

  function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
</script>
</body>
</html>`;
}

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
console.log("chicken")
