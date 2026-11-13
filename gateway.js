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
import util from "util";
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
// gateway.log is renamed to gateway.log.1 (replacing it) whenever it grows past this size.
const LOG_MAX_BYTES = parseInt(process.env.GATEWAY_LOG_MAX_BYTES || "", 10) || 10 * 1024 * 1024;
fs.mkdirSync(logDir, { recursive: true });

// Written synchronously through a plain fd: every line is on disk before the next one, so
// rotating is just close -> rename -> reopen with nothing buffered in between to lose
// (Windows also refuses to rename a file that is still open).
let logFd;
let logBytes = 0;
function openLog() {
  logFd = fs.openSync(logFile, "a");
  logBytes = fs.fstatSync(logFd).size;
}
function rotateLog() {
  fs.closeSync(logFd);
  logFd = null; // Never write to a closed fd number the OS may have reused.
  try {
    fs.renameSync(logFile, `${logFile}.1`);
  } catch {
    // e.g. gateway.log.1 is open in a viewer on Windows: keep appending, retry next line.
  }
  openLog();
}
function writeLog(text) {
  try {
    if (logFd == null) openLog();
    else if (logBytes >= LOG_MAX_BYTES) rotateLog();
    logBytes += fs.writeSync(logFd, text);
  } catch {
    // Logging must never take the gateway down.
  }
}
openLog();

function formatLogArg(a) {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack;
  try {
    const json = JSON.stringify(a);
    if (json !== undefined) return json;
  } catch {
    // Circular structure, BigInt, throwing toJSON...
  }
  return util.inspect(a, { depth: 4, breakLength: Infinity });
}

// Modules log everything via console.error (stdout is reserved in stdio mode),
// so label by content: only real failures are written as [error].
const ERROR_PATTERN = /❌|error|fail|exception|refused|timeout|失敗|錯誤|逾時/i;
for (const level of ["log", "info", "warn", "error"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const line = args.map(formatLogArg).join(" ");
    const label = level === "error" && !ERROR_PATTERN.test(line) ? "info" : level;
    writeLog(`${new Date().toISOString()} [${label}] ${line}\n`);
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
// A session with an open HTTP stream (the client's GET event stream, or a request
// still running) is alive. After its last stream closes and it stays idle this long,
// it is removed; a client that comes back gets 404 and re-initializes (MCP spec).
const sessionIdleMinutes =
  config.sessionIdleMinutes ?? (config.sessionIdleHours != null ? config.sessionIdleHours * 60 : 30);
const sessionIdleMs = sessionIdleMinutes * 60 * 1000;

// name -> { name, module, mod?, error? }
const instances = new Map();
async function loadInstance(name, spec) {
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
// Load all instances concurrently (module imports are cached, so shared modules load once).
await Promise.all(Object.entries(config.instances || {}).map(([name, spec]) => loadInstance(name, spec)));

// ---------------------------------------------------------------- sessions
// sessionId -> { instance, client, transport, server, lastSeen, openStreams }
const sessions = new Map();

async function createSession(instance, client) {
  const server = new McpServer(instance.mod.info);
  instance.mod.register(server);

  const session = { instance: instance.name, client, server, lastSeen: Date.now(), openStreams: 0 };
  session.transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (sessionId) => {
      sessions.set(sessionId, session);
      console.error(`➕ session ${sessionId} -> ${instance.name} [${client}]（共 ${sessions.size}）`);
    }
  });
  session.transport.onclose = () => {
    const sessionId = session.transport.sessionId;
    if (sessionId && sessions.delete(sessionId)) {
      const reason = session.closeReason || "closed by client";
      console.error(`➖ session ${sessionId} -> ${instance.name} [${client}] ${reason}（共 ${sessions.size}）`);
    }
  };

  await server.connect(session.transport);
  return session;
}

function reapIdleSessions() {
  const now = Date.now();
  for (const session of sessions.values()) {
    if (session.openStreams === 0 && now - session.lastSeen > sessionIdleMs) {
      session.closeReason = `idle ${Math.round((now - session.lastSeen) / 60000)} min`;
      session.transport.close().catch(() => {});
    }
  }
}
setInterval(reapIdleSessions, 60 * 1000).unref();

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
  // One pass over sessions instead of one filter per instance.
  let connectedSessions = 0;
  const clients = {};
  const perInstance = {};
  for (const s of sessions.values()) {
    if (s.openStreams > 0) connectedSessions++;
    clients[s.client] = (clients[s.client] || 0) + 1;
    perInstance[s.instance] = (perInstance[s.instance] || 0) + 1;
  }

  return {
    ok: true,
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    sessions: sessions.size,
    connectedSessions,
    sessionIdleMinutes,
    clients,
    instances: [...instances.values()].map((i) => ({
      name: i.name,
      module: i.module,
      url: `http://${host}:${port}/${i.name}/mcp`,
      sessions: perInstance[i.name] || 0,
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
      session = await createSession(instance, String(req.headers["user-agent"] || "unknown").slice(0, 60));
    } else if (sessionId) {
      // Per the MCP spec, 404 tells the client to start a new session.
      return rpcError(res, 404, -32001, "Session not found");
    } else {
      return rpcError(res, 400, -32000, "Bad Request: No valid session ID provided");
    }
  }

  session.lastSeen = Date.now();
  session.openStreams++;
  res.on("close", () => {
    session.openStreams--;
    session.lastSeen = Date.now();
  });
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
  await Promise.allSettled([...sessions.values()].map((s) => s.transport.close()));
  await Promise.allSettled([...instances.values()].map(async (i) => i.mod?.close?.()));
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
