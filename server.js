// server.js — Fly.io backend
// Serves static frontend from ./public/
//   /bare/*         → Ultraviolet bare proxy
//   /terminal       → WebSocket PTY shell (node-pty)
//   /void-config.js → injects wss:// URL so the frontend auto-connects

import { createBareServer } from "@tomphttp/bare-server-node";
import express from "express";
import http from "node:http";
import cors from "cors";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { WebSocketServer } from "ws";
import pty from "node-pty";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const bare = createBareServer("/bare/");
const app  = express();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET","POST","PUT","DELETE","OPTIONS","HEAD","PATCH"],
  allowedHeaders: ["*"],
  exposedHeaders: ["*"],
  credentials: true,
}));

// ── Strip headers that block embedding ───────────────────────────────────────
app.use((req, res, next) => {
  const orig = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    const n = name.toLowerCase();
    if ([
      "x-frame-options",
      "content-security-policy",
      "cross-origin-embedder-policy",
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
    ].includes(n)) return;
    orig(name, value);
  };
  next();
});

// ── Bare proxy ────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  if (bare.shouldRoute(req)) bare.routeRequest(req, res);
  else next();
});

// ── Dynamic config — tells the frontend its own wss:// URL ───────────────────
// Fly.io terminates TLS at the edge and forwards with fly-forwarded-proto.
app.get("/void-config.js", (req, res) => {
  const proto =
    req.headers["fly-forwarded-proto"] === "https" ||
    req.headers["x-forwarded-proto"]   === "https"
      ? "wss" : "ws";
  const host = req.headers["fly-forwarded-host"] ||
               req.headers["x-forwarded-host"]   ||
               req.headers.host;
  const wsUrl = `${proto}://${host}/terminal`;
  res.setHeader("Content-Type", "application/javascript");
  res.send(`window.__voidWsUrl = ${JSON.stringify(wsUrl)};`);
});

// ── Static frontend ───────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Health check (Fly.io uses this to know the app is alive) ──────────────────
app.get("/health", (req, res) => {
  const host = req.headers["fly-forwarded-host"] ||
               req.headers["x-forwarded-host"]   ||
               req.headers.host || "your-app.fly.dev";
  res.json({
    status: "ok",
    service: "VOID Proxy (Fly.io)",
    version: "3.0",
    bare: "/bare/",
    terminal: `wss://${host}/terminal`,
    frontend: `https://${host}/`,
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

// ── PTY terminal ──────────────────────────────────────────────────────────────
const SHELL = process.env.SHELL || (os.platform() === "win32" ? "powershell.exe" : "bash");
const termWss = new WebSocketServer({ noServer: true });

termWss.on("connection", (ws, req) => {
  const sessionId = new URL(req.url, "http://localhost").searchParams.get("session") || "unknown";
  console.log(`[terminal] connected  session=${sessionId}`);

  const ptyProc = pty.spawn(SHELL, [], {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    cwd: process.env.HOME || "/root",
    env: {
      ...process.env,
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: "en_US.UTF-8",
    },
  });

  console.log(`[terminal] PID ${ptyProc.pid} (${SHELL})  session=${sessionId}`);

  ptyProc.onData(data => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  ptyProc.onExit(({ exitCode }) => {
    console.log(`[terminal] exited (${exitCode})  session=${sessionId}`);
    if (ws.readyState === ws.OPEN) ws.close();
  });

  ws.on("message", (msg) => {
    const text = msg.toString("utf8");
    try {
      const obj = JSON.parse(text);
      if (obj.type === "input")  ptyProc.write(obj.data);
      if (obj.type === "resize") ptyProc.resize(Math.max(1, obj.cols | 0), Math.max(1, obj.rows | 0));
    } catch (_) {
      ptyProc.write(text);
    }
  });

  ws.on("close", () => {
    console.log(`[terminal] disconnected  session=${sessionId}`);
    try { ptyProc.kill(); } catch (_) {}
  });

  ws.on("error", (err) => {
    console.error(`[terminal] error  session=${sessionId}:`, err.message);
    try { ptyProc.kill(); } catch (_) {}
  });
});

// ── HTTP server + WebSocket upgrade handler ───────────────────────────────────
const server = http.createServer(app);

server.on("upgrade", (req, socket, head) => {
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (bare.shouldRoute(req)) {
    bare.routeUpgrade(req, socket, head);
  } else if (pathname === "/terminal") {
    termWss.handleUpgrade(req, socket, head, ws => termWss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// Fly.io internally routes to PORT (default 8080); TLS is handled at the edge.
const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () => {
  console.log(`VOID Proxy (Fly.io) running on :${PORT}`);
  console.log(`  Frontend → https://<app>.fly.dev/`);
  console.log(`  Bare     → https://<app>.fly.dev/bare/`);
  console.log(`  Terminal → wss://<app>.fly.dev/terminal`);
  console.log(`  Config   → https://<app>.fly.dev/void-config.js`);
});

export default app;
