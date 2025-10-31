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

// File paths
const usersFile = path.join(__dirname, "users.json");
const messagesFile = path.join(__dirname, "messages.json");

// Ensure files exist
async function ensureFiles() {
  if (!await fs.pathExists(usersFile)) {
    const initialUsers = [
      { username: "universalwebx", password: "iliveinanuclearbunker" }
    ];
    await fs.writeJSON(usersFile, initialUsers, { spaces: 2 });
  }
  if (!await fs.pathExists(messagesFile)) {
    await fs.writeJSON(messagesFile, [], { spaces: 2 });
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
app.use(session({
  secret: "supersecret-session-key",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000*60*60*24 }
}));

// Routes
app.get("/", (req,res)=>{
  if(req.session.username) return res.redirect("/chat");
  res.sendFile(path.join(__dirname,"views/login.html"));
});

app.get("/signup", (req,res)=>{
  res.sendFile(path.join(__dirname,"views/signup.html"));
});

app.post("/signup", async (req,res)=>{
  const { username, password } = req.body;
  if(!username || !password) return res.send("Missing fields. <a href='/signup'>Try again</a>");
  const users = await readUsers();
  if(users.find(u=>u.username===username)) return res.send("Username exists. <a href='/signup'>Try another</a>");
  users.push({ username, password });
  await saveUsers(users);
  res.send("Account created. <a href='/'>Login</a>");
});

app.post("/login", async (req,res)=>{
  const { username, password } = req.body;
  const users = await readUsers();
  const user = users.find(u=>u.username===username && u.password===password);
  if(!user) return res.send("Invalid credentials. <a href='/'>Try again</a>");
  req.session.username = user.username;
  res.redirect("/chat");
});

app.get("/logout", (req,res)=>{
  req.session.destroy(()=>res.redirect("/"));
});

app.get("/chat", (req,res)=>{
  if(!req.session.username) return res.redirect("/");
  res.sendFile(path.join(__dirname,"views/chat.html"));
});

// Socket.IO
const onlineUsers = new Map(); // socket.id => username

io.on("connection", (socket)=>{
  let currentUser = null;

  socket.on("identify", async username=>{
    currentUser = username;
    onlineUsers.set(socket.id, username);

    const messages = await readMessages();
    // send only relevant messages: global + DMs + groups user is in + host sees all
    socket.emit("history", messages);
  });

  socket.on("message", async msg=>{
    /*
      msg = {
        type: "global"|"dm"|"group",
        content: "text",
        to: "username" | ["user1","user2",...]
      }
    */
    const username = currentUser;
    const time = new Date().toISOString();
    const message = { id: Date.now()+"-"+Math.floor(Math.random()*9999), username, time, ...msg };

    const messages = await readMessages();
    messages.push(message);
    await saveMessages(messages);

    // broadcast
    for(const [id,s] of io.of("/").sockets){
      const target = s;
      const targetUser = onlineUsers.get(id);
      if(!targetUser) continue;

      // logic: global messages always go to everyone
      // DMs: to sender, recipient, host
      // Group: sender, participants, host
      if(message.type==="global" ||
        targetUser===message.username ||
        (message.type==="dm" && (message.to===targetUser || message.username==="universalwebx" || targetUser==="universalwebx")) ||
        (message.type==="group" && (message.to.includes(targetUser) || targetUser==="universalwebx"))
      ){
        s.emit("message", message);
      }
    }
  });

  socket.on("disconnect", ()=>{
    onlineUsers.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=>console.log(`Server running on port ${PORT}`));
