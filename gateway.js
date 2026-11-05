// MCP gateway: one long-running process that serves every configured MCP server
// over Streamable HTTP at http://<host>:<port>/<instance-name>/mcp.
//
// Each Claude Code / MCP client gets its own MCP session, while database pools,
// SSH tunnels and broker connections are created once per instance (on first
// tool call) and shared by all sessions.
//
// Config: gateway.config.json (see gateway.config.example.json).
import fs from "fs";
import http from "http";
import path from "path";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { loadEnvFile } from "./lib/common.js";

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(rootDir, process.env.GATEWAY_CONFIG || "gateway.config.json");
const MODULES = ["hello", "files", "axios", "mysql", "mongodb", "tdengine", "kafka", "mqtt", "outlook"];
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------- logging
const logDir = path.join(rootDir, "logs");
const logFile = path.join(logDir, "gateway.log");
fs.mkdirSync(logDir, { recursive: true });
try {
  if (fs.statSync(logFile).size > 10 * 1024 * 1024) {
    fs.renameSync(logFile, `${logFile}.1`);
  }
} catch {
  // No log file yet.
}
const logStream = fs.createWriteStream(logFile, { flags: "a" });
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack : JSON.stringify(a))).join(" ");
    logStream.write(`${new Date().toISOString()} [${level}] ${line}\n`);
    original(...args);
  };
}

// Keep serving other instances if one module throws asynchronously.
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

// ---------------------------------------------------------------- config
if (!fs.existsSync(configPath)) {
  console.error(`❌ 找不到設定檔 ${configPath}，請參考 gateway.config.example.json 建立`);
  process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const host = process.env.GATEWAY_HOST || config.host || "127.0.0.1";
const port = parseInt(process.env.GATEWAY_PORT || config.port || 3800, 10);
const sessionIdleMs = (config.sessionIdleHours ?? 168) * 3600 * 1000;

// name -> { name, module, mod?, error? }
const instances = new Map();
for (const [name, spec] of Object.entries(config.instances || {})) {
  const entry = { name, module: spec.module };
  instances.set(name, entry);
  try {
    if (!MODULES.includes(spec.module)) {
      throw new Error(`未知的 module: ${spec.module}`);
    }
    const { default: create } = await import(`./modules/${spec.module}.js`);
    const envFile = spec.envFile ? path.resolve(rootDir, spec.envFile) : null;
    if (envFile && !fs.existsSync(envFile)) {
      throw new Error(`找不到 envFile: ${envFile}`);
    }
    // Instance env: gateway process env, overridden by the instance's env file and inline env.
    const env = { ...process.env, ...loadEnvFile(envFile), ...(spec.env || {}) };
    entry.mod = create({ env, argv: spec.args || [] });
  } catch (err) {
    entry.error = err.message;
    console.error(`❌ instance ${name} 載入失敗: ${err.message}`);
  }
}

// ---------------------------------------------------------------- sessions
// sessionId -> { instance, transport, server, lastSeen }
const sessions = new Map();

async function createSession(instance) {
  const server = new McpServer(instance.mod.info);
  instance.mod.register(server);

  const session = { instance: instance.name, server, lastSeen: Date.now() };
  session.transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
      console.error(`➕ session ${sessionId} -> ${instance.name}（共 ${sessions.size}）`);
    }
  });
  session.transport.onclose = () => {
    const sessionId = session.transport.sessionId;
    if (sessionId && sessions.delete(sessionId)) {
      console.error(`➖ session ${sessionId} -> ${instance.name}（共 ${sessions.size}）`);
    }
  };

  await server.connect(session.transport);
  return session;
}

setInterval(() => {
  const now = Date.now();
  for (const [sessionId, session] of sessions) {
    if (now - session.lastSeen > sessionIdleMs) {
      session.transport.close().catch(() => {});
      sessions.delete(sessionId);
    }
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------- http
function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function rpcError(res, status, code, message) {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : undefined);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Only accept local Host headers (DNS rebinding protection).
const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

function status() {
  return {
    ok: true,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    sessions: sessions.size,
    instances: [...instances.values()].map((i) => ({
      name: i.name,
      module: i.module,
      url: `http://${host}:${port}/${i.name}/mcp`,
      sessions: [...sessions.values()].filter((s) => s.instance === i.name).length,
      ...(i.error ? { error: i.error } : {})
    }))
  };
}

async function handle(req, res) {
  if (!allowedHosts.has(req.headers.host)) {
    return sendJson(res, 403, { error: `Host not allowed: ${req.headers.host}` });
  }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  if (pathname === "/" || pathname === "/health") {
    return sendJson(res, 200, status());
  }

  const match = pathname.match(/^\/([^/]+)\/mcp\/?$/);
  const instance = match && instances.get(decodeURIComponent(match[1]));
  if (!instance) {
    return sendJson(res, 404, { error: `Unknown MCP instance: ${pathname}` });
  }
  if (instance.error) {
    return rpcError(res, 500, -32603, `Instance ${instance.name} failed to load: ${instance.error}`);
  }

  let body;
  if (req.method === "POST") {
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return rpcError(res, 400, -32700, `Parse error: ${err.message}`);
    }
  }

  const sessionId = req.headers["mcp-session-id"];
  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (session && session.instance !== instance.name) {
    return rpcError(res, 400, -32000, "Session belongs to a different instance");
  }

  if (!session) {
    const isInit = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
    if (req.method === "POST" && !sessionId && isInit) {
      session = await createSession(instance);
    } else if (sessionId) {
      // Per the MCP spec, 404 tells the client to start a new session.
      return rpcError(res, 404, -32001, "Session not found");
    } else {
      return rpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
    }
  }

  session.lastSeen = Date.now();
  await session.transport.handleRequest(req, res, body);
}

const httpServer = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("request error:", err);
    rpcError(res, 500, -32603, `Internal error: ${err.message}`);
  });
});

httpServer.on("error", (err) => {
  console.error(`❌ HTTP server 錯誤: ${err.message}`);
  process.exit(1);
});

httpServer.listen(port, host, () => {
  const ok = [...instances.values()].filter((i) => !i.error).length;
  console.error(`✅ MCP gateway 已啟動 http://${host}:${port}（pid ${process.pid}，${ok}/${instances.size} instances）`);
});

async function shutdown(signal) {
  console.error(`⏹️ 收到 ${signal}，關閉 gateway`);
  httpServer.close();
  for (const session of sessions.values()) {
    await session.transport.close().catch(() => {});
  }
  for (const instance of instances.values()) {
    await instance.mod?.close?.().catch(() => {});
  }
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
