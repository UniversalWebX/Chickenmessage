import express from "express";
import http from "http";
import { Server as IOServer } from "socket.io";
import session from "express-session";
import fs from "fs-extra";
import path from "path";
import bodyParser from "body-parser";

const app = express();
const server = http.createServer(app);
const io = new IOServer(server);

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DATA = (p)=>path.join(ROOT,p);

const USERS_FILE = DATA("users.json");
const MESSAGES_FILE = DATA("messages.json");
const BANS_FILE = DATA("bans.json");
const SITE_FILE = DATA("site.json");

if(!fs.pathExistsSync(USERS_FILE)){
  fs.writeJSONSync(USERS_FILE, { "universalwebx": { "password":"iliveinanuclearbunker", "role":"host" } }, { spaces:2 });
}
if(!fs.pathExistsSync(MESSAGES_FILE)){
  fs.writeJSONSync(MESSAGES_FILE, [], { spaces:2 });
}
if(!fs.pathExistsSync(BANS_FILE)){
  fs.writeJSONSync(BANS_FILE, { username: [], ip: [] }, { spaces:2 });
}
if(!fs.pathExistsSync(SITE_FILE)){
  fs.writeJSONSync(SITE_FILE, { locked: false }, { spaces:2 });
}

const read = async (file)=> fs.readJSON(file);
const write = async (file, data)=> fs.writeJSON(file, data, { spaces: 2 });

app.use(bodyParser.json());
app.use(express.urlencoded({ extended:true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecret-session-key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24 }
}));
app.use(express.static(path.join(ROOT,"views")));

app.get("/", (req,res)=> {
  if(req.session.username) return res.redirect("/chat");
  res.sendFile(path.join(ROOT,"views/login.html"));
});
app.get("/signup", (req,res)=> res.sendFile(path.join(ROOT,"views/signup.html")));
app.get("/chat", (req,res)=>{
  if(!req.session.username) return res.redirect("/");
  res.sendFile(path.join(ROOT,"views/chat.html"));
});
app.get("/host", (req,res)=>{
  if(!req.session.username) return res.redirect("/");
  res.sendFile(path.join(ROOT,"views/host.html"));
});
app.get("/me", (req,res)=>{
  if(!req.session.username) return res.json({ ok:false });
  return res.json({ ok:true, username: req.session.username, role: req.session.role || "user" });
});

app.post("/signup", async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.json({ ok:false, error:"missing" });
  const users = await read(USERS_FILE);
  if(users[username]) return res.json({ ok:false, error:"exists" });
  const bans = await read(BANS_FILE);
  const userBan = (bans.username || []).find(b=>b.name===username && (!b.expires || new Date(b.expires) > new Date()));
  if(userBan) return res.json({ ok:false, error:"banned" });
  users[username] = { password, role: "user" };
  await write(USERS_FILE, users);
  return res.json({ ok:true });
});

app.post("/login", async (req,res)=>{
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const { username, password } = req.body;
  const users = await read(USERS_FILE);
  const user = users[username];
  if(!user || user.password !== password) return res.json({ ok:false, error:"invalid" });
  const site = await read(SITE_FILE);
  if(site.locked && !(user.role === "host" || user.role === "admin")) {
    return res.json({ ok:false, error:"locked" });
  }
  const bans = await read(BANS_FILE);
  const ipBan = (bans.ip || []).find(b=>b.ip===ip && (!b.expires || new Date(b.expires) > new Date()));
  if(ipBan) return res.json({ ok:false, error:"ipbanned" });
  const userBan = (bans.username || []).find(b=>b.name===username && (!b.expires || new Date(b.expires) > new Date()));
  if(userBan) return res.json({ ok:false, error:"userbanned" });
  req.session.username = username;
  req.session.role = user.role || "user";
  return res.json({ ok:true, role: req.session.role });
});

app.get("/logout", (req,res)=>{
  req.session.destroy(()=> res.redirect("/"));
});

const requireRole = (...roles)=> async (req,res,next) => {
  if(!req.session.username) return res.status(403).json({ ok:false, error:"notlogged" });
  const users = await read(USERS_FILE);
  const me = users[req.session.username];
  if(!me || !roles.includes(me.role)) return res.status(403).json({ ok:false, error:"forbidden" });
  req.me = me;
  next();
};

app.post("/api/ban", requireRole("host","admin"), async (req,res)=>{
  const { username, durationMinutes } = req.body;
  if(!username) return res.json({ ok:false, error:"missing" });
  const bans = await read(BANS_FILE);
  const expires = durationMinutes ? new Date(Date.now()+durationMinutes*60000).toISOString() : null;
  bans.username = bans.username || [];
  bans.username.push({ name: username, by: req.me.username, expires });
  await write(BANS_FILE, bans);
  return res.json({ ok:true });
});

app.post("/api/unban", requireRole("host","admin"), async (req,res)=>{
  const { username } = req.body;
  const bans = await read(BANS_FILE);
  bans.username = (bans.username || []).filter(b=>b.name!==username);
  await write(BANS_FILE, bans);
  return res.json({ ok:true });
});

app.post("/api/ipban", requireRole("host"), async (req,res)=>{
  const { ip, durationMinutes } = req.body;
  if(!ip) return res.json({ ok:false, error:"missing" });
  const bans = await read(BANS_FILE);
  const expires = durationMinutes ? new Date(Date.now()+durationMinutes*60000).toISOString() : null;
  bans.ip = bans.ip || [];
  bans.ip.push({ ip, by: req.me.username, expires });
  await write(BANS_FILE, bans);
  return res.json({ ok:true });
});
app.post("/api/unipban", requireRole("host"), async (req,res)=>{
  const { ip } = req.body;
  const bans = await read(BANS_FILE);
  bans.ip = (bans.ip || []).filter(b=>b.ip!==ip);
  await write(BANS_FILE, bans);
  return res.json({ ok:true });
});

app.post("/api/giveadmin", requireRole("host"), async (req,res)=>{
  const { username } = req.body;
  const users = await read(USERS_FILE);
  if(!users[username]) return res.json({ ok:false, error:"nouser" });
  users[username].role = "admin";
  await write(USERS_FILE, users);
  return res.json({ ok:true });
});
app.post("/api/removeadmin", requireRole("host"), async (req,res)=>{
  const { username } = req.body;
  const users = await read(USERS_FILE);
  if(!users[username]) return res.json({ ok:false, error:"nouser" });
  users[username].role = "user";
  await write(USERS_FILE, users);
  return res.json({ ok:true });
});

app.post("/api/lock", requireRole("host"), async (req,res)=>{
  const site = await read(SITE_FILE);
  site.locked = true;
  await write(SITE_FILE, site);
  return res.json({ ok:true });
});
app.post("/api/unlock", requireRole("host"), async (req,res)=>{
  const site = await read(SITE_FILE);
  site.locked = false;
  await write(SITE_FILE, site);
  return res.json({ ok:true });
});

app.post("/api/announce", requireRole("host","admin"), async (req,res)=>{
  const { content } = req.body;
  if(!content) return res.json({ ok:false, error:"missing" });
  const messages = await read(MESSAGES_FILE);
  const msg = { id: Date.now()+"-ann", username: req.me.username, time: new Date().toISOString(), type:"announcement", content };
  messages.push(msg);
  await write(MESSAGES_FILE, messages);
  io.emit("message", msg);
  return res.json({ ok:true });
});

app.get("/api/state", requireRole("host","admin"), async (req,res)=>{
  const users = await read(USERS_FILE);
  const bans = await read(BANS_FILE);
  const site = await read(SITE_FILE);
  return res.json({ ok:true, users, bans, site });
});

const online = new Map();

io.on("connection", (socket)=>{
  let meUser = null;
  const ip = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

  socket.on("register", async (username)=>{
    meUser = username;
    online.set(socket.id, { username, ip });

    const messages = await read(MESSAGES_FILE);
    const users = await read(USERS_FILE);
    const me = users[username];
    const role = me ? me.role : "user";

    if(role === "host" || role === "admin"){
      socket.emit("history", messages);
    } else {
      const filtered = messages.filter(m=>{
        if(m.type === "global" || m.type === "announcement") return true;
        if(m.type === "dm") return m.username === username || m.to === username;
        if(m.type === "group") return Array.isArray(m.to) && m.to.includes(username);
        return false;
      });
      socket.emit("history", filtered);
    }
  });

  socket.on("send", async (payload)=>{
    if(!meUser) return;
    const users = await read(USERS_FILE);
    const me = users[meUser];
    const role = me ? me.role : "user";

    const bans = await read(BANS_FILE);
    const userBan = (bans.username || []).find(b=>b.name===meUser && (!b.expires || new Date(b.expires) > new Date()));
    const ipBan = (bans.ip || []).find(b=>b.ip===ip && (!b.expires || new Date(b.expires) > new Date()));
    if(userBan || ipBan){
      socket.emit("errorMsg", "You are banned.");
      return;
    }

    const site = await read(SITE_FILE);
    if(site.locked && !(role==="host" || role==="admin")){
      socket.emit("errorMsg", "Site locked.");
      return;
    }

    const time = new Date().toISOString();
    const message = { id: Date.now()+"-"+Math.floor(Math.random()*9999), username: meUser, time, ...payload };
    const messages = await read(MESSAGES_FILE);
    messages.push(message);
    await write(MESSAGES_FILE, messages);

    for(const [id, s] of io.of("/").sockets){
      const info = online.get(id);
      if(!info) continue;
      const target = info.username;
      const usersObj = await read(USERS_FILE);
      const targetRole = usersObj[target] ? usersObj[target].role : "user";

      let send = false;
      if(message.type === "global" || message.type === "announcement") send = true;
      if(message.type === "dm"){
        if(message.username === target || message.to === target) send = true;
      }
      if(message.type === "group"){
        if(Array.isArray(message.to) && message.to.includes(target)) send = true;
      }
      if(targetRole === "host" || targetRole === "admin") send = true;

      if(send) s.emit("message", message);
    }
  });

  socket.on("disconnect", ()=> online.delete(socket.id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log("Server listening on", PORT));
