import express from "express";
import session from "express-session";
import path from "path";
import fs from "fs-extra";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const usersFile = path.join(__dirname, "users.json");

// Create users.json if not exists
if (!fs.existsSync(usersFile)) fs.writeJSONSync(usersFile, []);

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false
}));
app.use(express.static(path.join(__dirname, "views")));

// Utility functions
async function getUsers() {
  return await fs.readJSON(usersFile);
}

async function saveUsers(users) {
  await fs.writeJSON(usersFile, users, { spaces: 2 });
}

// Routes
app.get("/", (req, res) => {
  if (req.session.role === "host") return res.redirect("/host");
  if (req.session.role === "user") return res.redirect("/user");
  res.sendFile(path.join(__dirname, "views/login.html"));
});

app.get("/signup", (req, res) => {
  res.sendFile(path.join(__dirname, "views/signup.html"));
});

// Handle signup
app.post("/signup", async (req, res) => {
  const { username, password, role } = req.body;
  const users = await getUsers();

  if (users.find(u => u.username === username)) {
    return res.send("Username already exists. <a href='/signup'>Try again</a>");
  }

  users.push({ username, password, role });
  await saveUsers(users);
  res.send("Account created! <a href='/'>Login now</a>");
});

// Handle login
app.post("/login", async (req, res) => {
  const { username, password } = req.body;
  const users = await getUsers();

  const user = users.find(u => u.username === username && u.password === password);
  if (!user) {
    return res.send("Invalid credentials. <a href='/'>Try again</a>");
  }

  req.session.role = user.role;
  req.session.username = username;

  if (user.role === "host") return res.redirect("/host");
  return res.redirect("/user");
});

// Host and user routes
app.get("/host", (req, res) => {
  if (req.session.role !== "host") return res.redirect("/");
  res.sendFile(path.join(__dirname, "views/host.html"));
});

app.get("/user", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");
  res.sendFile(path.join(__dirname, "views/user.html"));
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
