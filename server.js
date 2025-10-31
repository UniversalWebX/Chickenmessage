import express from "express";
import session from "express-session";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: "supersecret",
  resave: false,
  saveUninitialized: false
}));

// Serve static files from /views for simplicity
app.use(express.static(path.join(__dirname, "views")));

// Login page
app.get("/", (req, res) => {
  if (req.session.role === "host") return res.redirect("/host");
  if (req.session.role === "user") return res.redirect("/user");
  res.sendFile(path.join(__dirname, "views/login.html"));
});

// Handle login
app.post("/login", (req, res) => {
  const { password } = req.body;
  if (password === "hamborgeer") {
    req.session.role = "host";
    return res.redirect("/host");
  } else if (password === "banana") {
    req.session.role = "user";
    return res.redirect("/user");
  } else {
    return res.send("Wrong password. <a href='/'>Try again</a>");
  }
});

// Host page
app.get("/host", (req, res) => {
  if (req.session.role !== "host") return res.redirect("/");
  res.sendFile(path.join(__dirname, "views/host.html"));
});

// User page
app.get("/user", (req, res) => {
  if (req.session.role !== "user") return res.redirect("/");
  res.sendFile(path.join(__dirname, "views/user.html"));
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
