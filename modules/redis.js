import { z } from "zod";
import Redis from "ioredis";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { closeTunnel, errorResult, jsonResult, lazy, parseBooleanFlag, positiveInt, textResult } from "../lib/common.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const SCAN_COUNT = 1000;
// One redis_scan call runs at most this many SCAN round trips, so a sparse pattern over a large
// keyspace returns a cursor to continue from instead of walking every key in one call.
const MAX_SCAN_ROUNDS = 50;
const DEFAULT_MAX_RESPONSE_CHARS = 100000;
const DEFAULT_TIMEOUT_MS = 15000;

// Commands redis_command never runs. They change connection state shared by every session
// (SELECT, AUTH, MULTI...), block the shared connection (MONITOR, SUBSCRIBE, WAIT), walk or wipe
// the whole keyspace (KEYS, FLUSH*), or run arbitrary code (EVAL, FUNCTION).
// Most are also caught by BLOCKED_CATEGORIES; the list keeps them blocked whatever the server reports.
const BLOCKED_COMMANDS = new Set([
  "select", "swapdb", "move", "auth", "hello", "quit", "reset", "client", "readonly", "readwrite",
  "multi", "exec", "discard", "watch", "unwatch",
  "monitor", "sync", "psync", "replconf", "replicaof", "slaveof", "wait", "waitaof", "failover",
  "subscribe", "psubscribe", "ssubscribe", "unsubscribe", "punsubscribe", "sunsubscribe",
  "keys", "flushall", "flushdb", "shutdown", "debug", "config", "save", "bgsave", "bgrewriteaof",
  "eval", "eval_ro", "evalsha", "evalsha_ro", "fcall", "fcall_ro", "function", "script",
  "migrate", "restore", "restore-asking", "module", "acl", "cluster", "sentinel", "latency", "slowlog"
]);
const BLOCKED_CATEGORIES = new Set(["@admin", "@dangerous", "@blocking", "@pubsub", "@scripting", "@transaction"]);

// Decide what redis_command may do with a command, from its COMMAND INFO entry
// ({ flags: [...], categories: [...] }, lower-case). Returns "read", "write", or { blocked: reason }.
export function classifyCommand(name, info) {
  const lower = name.toLowerCase();
  const base = lower.split("|")[0];
  if (BLOCKED_COMMANDS.has(base) || BLOCKED_COMMANDS.has(lower)) {
    return { blocked: `${name} 不允許透過此工具執行` };
  }
  if (!info) {
    return { blocked: `未知的指令: ${name}` };
  }
  const category = info.categories.find((c) => BLOCKED_CATEGORIES.has(c));
  if (category) {
    return { blocked: `${name} 屬於 ${category}，不允許透過此工具執行` };
  }
  return info.flags.includes("write") || info.flags.includes("denyoom") ? "write" : "read";
}

// One COMMAND INFO reply entry: [name, arity, flags, firstKey, lastKey, step, aclCategories, tips,
// keySpecs, subcommands]. Subcommand entries have the same shape, named "parent|sub".
export function parseCommandInfo(entry) {
  if (!Array.isArray(entry)) return null;
  const lower = (list) => (Array.isArray(list) ? list.map((v) => String(v).toLowerCase()) : []);
  const subcommands = new Map();
  for (const sub of Array.isArray(entry[9]) ? entry[9] : []) {
    const parsed = parseCommandInfo(sub);
    if (parsed) subcommands.set(parsed.name, parsed);
  }
  return { name: String(entry[0]).toLowerCase(), flags: lower(entry[2]), categories: lower(entry[6]), subcommands };
}

// Keep the leading entries whose JSON fits in maxChars. Returns { entries, truncated }.
export function fitEntries(entries, maxChars) {
  let size = 2; // "[]"
  for (let i = 0; i < entries.length; i++) {
    size += JSON.stringify(entries[i]).length + (i > 0 ? 1 : 0);
    if (size > maxChars) return { entries: entries.slice(0, i), truncated: true };
  }
  return { entries, truncated: false };
}

// ioredis replies for ZRANGE WITHSCORES / HSCAN are flat [a, b, a, b, ...] arrays.
function pairs(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
}

export default function create({ env }) {
  const {
    REDIS_HOST = "127.0.0.1",
    REDIS_PORT = "6379",
    REDIS_USERNAME,
    REDIS_PASSWORD,
    REDIS_DB = "0",
    REDIS_TIMEOUT_MS,
    REDIS_MAX_RESPONSE_CHARS,
    REDIS_QUERY_OPERATION = "true",
    REDIS_WRITE_OPERATION = "true"
  } = env;

  const operationAccess = {
    query: parseBooleanFlag(REDIS_QUERY_OPERATION, true),
    write: parseBooleanFlag(REDIS_WRITE_OPERATION, true)
  };
  const maxResponseChars = positiveInt(REDIS_MAX_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS);
  const timeoutMs = positiveInt(REDIS_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const db = parseInt(REDIS_DB, 10) || 0;

  // Drop a client whose connection or SSH tunnel died; the next tool call builds new ones.
  function discard(ctx) {
    if (getClient.current() === ctx) getClient.reset();
    ctx.client?.disconnect();
    closeTunnel(ctx.target);
  }

  // Client (and SSH tunnel) are created on first use and shared by all sessions.
  const getClient = lazy(async () => {
    const redisPort = parseInt(REDIS_PORT, 10);
    if (Number.isNaN(redisPort)) {
      throw new Error("REDIS_PORT 不是有效數字，請檢查 .env 設定");
    }

    const sshConfig = getSshConfigFromEnv(env, "REDIS");
    const ctx = { target: { host: REDIS_HOST, port: redisPort }, commandInfo: new Map() };

    if (useSshTunnel(sshConfig)) {
      ctx.target = await createSshForwardTunnel({
        sshConfig,
        dstAddr: REDIS_HOST,
        dstPort: redisPort,
        onClose: () => discard(ctx)
      });
      console.error(`✅ 已建立 Redis SSH 通道（jump hops: ${sshConfig.jumps.length} -> ${REDIS_HOST}:${redisPort}）`);
    }

    // No reconnect and no offline queue: a dropped connection fails the pending call at once and
    // is rebuilt (with a fresh SSH tunnel) on the next tool call, instead of retrying a dead port.
    ctx.client = new Redis({
      host: ctx.target.host,
      port: ctx.target.port,
      username: REDIS_USERNAME?.trim() || undefined,
      password: REDIS_PASSWORD || undefined,
      db,
      lazyConnect: true,
      connectTimeout: timeoutMs,
      commandTimeout: timeoutMs,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null
    });
    // Without an "error" listener ioredis errors are unhandled and would reach the gateway's
    // process-level handler on every failure.
    ctx.client.on("error", (err) => console.error(`❌ Redis 連線錯誤: ${err.message}`));
    ctx.client.on("end", () => discard(ctx));

    try {
      await ctx.client.connect();
    } catch (err) {
      ctx.client.disconnect();
      closeTunnel(ctx.target);
      const hint = useSshTunnel(sshConfig)
        ? `（若 Redis 跑在 K8s pod，pod 重啟後 IP 會變，請確認 REDIS_HOST=${REDIS_HOST} 仍是目前的 pod IP）`
        : "";
      throw new Error(`Redis 連線失敗: ${err.message}${hint}`);
    }
    console.error(`✅ Redis 已就緒（${REDIS_HOST}:${redisPort} db ${db}）`);
    return ctx;
  });

  // COMMAND INFO, cached per command for the life of the connection.
  async function commandInfo(ctx, command, firstArg) {
    const name = command.toLowerCase();
    if (!ctx.commandInfo.has(name)) {
      const [entry] = await ctx.client.call("COMMAND", "INFO", name);
      ctx.commandInfo.set(name, parseCommandInfo(entry));
    }
    const info = ctx.commandInfo.get(name);
    const sub = firstArg && info?.subcommands.get(`${name}|${String(firstArg).toLowerCase()}`);
    return sub ? { name: sub.name, info: sub } : { name, info };
  }

  // Bounded read of one key: never more than `limit` entries, and never more than
  // maxResponseChars of string value.
  async function readKey(client, key, limit) {
    const type = await client.type(key);
    if (type === "none") return { key, exists: false };
    const ttlMs = await client.pttl(key);
    const result = { key, type, ttlMs: ttlMs >= 0 ? ttlMs : null };

    switch (type) {
      case "string": {
        result.length = await client.strlen(key);
        result.value = await client.getrange(key, 0, maxResponseChars - 1);
        result.truncated = result.length > maxResponseChars;
        return result;
      }
      case "hash": {
        result.length = await client.hlen(key);
        const entries = [];
        let cursor = "0";
        do {
          const [next, flat] = await client.hscan(key, cursor, "COUNT", Math.min(limit, SCAN_COUNT));
          entries.push(...pairs(flat));
          cursor = next;
        } while (cursor !== "0" && entries.length < limit);
        return withEntries(result, entries.slice(0, limit), (list) => Object.fromEntries(list));
      }
      case "list": {
        result.length = await client.llen(key);
        return withEntries(result, await client.lrange(key, 0, limit - 1));
      }
      case "set": {
        result.length = await client.scard(key);
        const members = [];
        let cursor = "0";
        do {
          const [next, batch] = await client.sscan(key, cursor, "COUNT", Math.min(limit, SCAN_COUNT));
          members.push(...batch);
          cursor = next;
        } while (cursor !== "0" && members.length < limit);
        return withEntries(result, members.slice(0, limit));
      }
      case "zset": {
        result.length = await client.zcard(key);
        const flat = await client.zrange(key, 0, limit - 1, "WITHSCORES");
        return withEntries(result, pairs(flat).map(([member, score]) => ({ member, score: Number(score) })));
      }
      case "stream": {
        result.length = await client.xlen(key);
        const items = await client.xrevrange(key, "+", "-", "COUNT", limit);
        result.order = "newest first";
        return withEntries(
          result,
          items.map(([id, fields]) => ({ id, fields: Object.fromEntries(pairs(fields)) }))
        );
      }
      default:
        result.value = null;
        result.hint = `不支援直接讀取 ${type} 型別，請改用 redis_command`;
        return result;
    }
  }

  function withEntries(result, entries, shape = (list) => list) {
    const fitted = fitEntries(entries, maxResponseChars);
    result.value = shape(fitted.entries);
    result.returned = fitted.entries.length;
    result.truncated = fitted.truncated || fitted.entries.length < result.length;
    return result;
  }

  // A reply too large for the response limit is cut and marked; the model sees the beginning.
  function limitedJson(value) {
    const json = JSON.stringify(value ?? null);
    if (json.length <= maxResponseChars) return textResult(json);
    return jsonResult({
      truncated: true,
      totalChars: json.length,
      preview: json.slice(0, maxResponseChars),
      hint: "回應超過大小上限：改用 redis_get（分批讀取）或縮小範圍（HSCAN / LRANGE / ZRANGE 加上範圍）"
    });
  }

  return {
    info: { name: "redis-tools", version: "1.0.0" },
    warmup: getClient,

    async close() {
      const ctx = getClient.current();
      if (ctx) {
        ctx.client.disconnect();
        closeTunnel(ctx.target);
      }
    },

    register(server) {
      // Tools turned off with REDIS_*_OPERATION=false are not registered at all.
      if (operationAccess.query) {
        server.tool(
          "redis_scan",
          "List keys matching a glob pattern with SCAN (never KEYS). Returns { keys, cursor, done }; when done is false, " +
            "pass cursor back to continue. One call runs a bounded number of SCAN rounds, so a sparse pattern may return few " +
            "keys with done: false. May return slightly more than limit.",
          {
            pattern: z.string().optional().describe('glob, e.g. "hse:*" (default "*")'),
            type: z.enum(["string", "hash", "list", "set", "zset", "stream"]).optional(),
            cursor: z.string().optional().describe("from a previous call; default 0"),
            limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`default ${DEFAULT_LIMIT}`)
          },
          async ({ pattern = "*", type, cursor = "0", limit = DEFAULT_LIMIT }) => {
            try {
              const { client } = await getClient();
              const keys = [];
              let chars = 0;
              let rounds = 0;
              // Stop on count or size: a SCAN batch cannot be split without losing keys (the cursor
              // resumes after the whole batch), so the reply is never cut and keeps a valid cursor.
              do {
                const args = [cursor, "MATCH", pattern, "COUNT", Math.min(SCAN_COUNT, limit)];
                if (type) args.push("TYPE", type);
                const [next, batch] = await client.scan(...args);
                keys.push(...batch);
                for (const key of batch) chars += key.length + 3;
                cursor = next;
                rounds++;
              } while (cursor !== "0" && keys.length < limit && chars < maxResponseChars && rounds < MAX_SCAN_ROUNDS);
              return jsonResult({ keys, cursor, done: cursor === "0" });
            } catch (err) {
              return errorResult(`SCAN 失敗: ${err.message}`);
            }
          }
        );

        server.tool(
          "redis_get",
          "Read one key whatever its type, with TTL. Collections (hash / list / set / zset / stream) return at most " +
            "limit entries plus the total length; a long string is cut to the size limit. Streams return the newest entries.",
          {
            key: z.string(),
            limit: z.number().int().min(1).max(MAX_LIMIT).optional().describe(`max entries for collections, default ${DEFAULT_LIMIT}`)
          },
          async ({ key, limit = DEFAULT_LIMIT }) => {
            try {
              const { client } = await getClient();
              return jsonResult(await readKey(client, key, limit));
            } catch (err) {
              return errorResult(`讀取失敗: ${err.message}`);
            }
          }
        );

        server.tool(
          "redis_info",
          "Server INFO (optionally one section: server, clients, memory, persistence, stats, replication, keyspace...) " +
            "plus the key count of the configured db.",
          { section: z.string().optional() },
          async ({ section }) => {
            try {
              const { client } = await getClient();
              const info = section ? await client.info(section) : await client.info();
              const dbsize = await client.dbsize();
              return textResult(`# dbsize (db ${db})\r\ndbsize:${dbsize}\r\n\r\n${info}`);
            } catch (err) {
              return errorResult(`INFO 失敗: ${err.message}`);
            }
          }
        );
      }

      if (operationAccess.query || operationAccess.write) {
        const allowed = [operationAccess.query && "read", operationAccess.write && "write"].filter(Boolean).join(" and ");
        server.tool(
          "redis_command",
          `Run one Redis command (${allowed} commands allowed), e.g. { command: "HGET", args: ["user:1", "name"] }. ` +
            "Admin, dangerous, blocking, pub/sub, scripting and transaction commands are refused, as are KEYS (use redis_scan), " +
            "SELECT, CONFIG and FLUSH*. The whole reply is read before the size limit cuts it: for large keys use redis_get or a ranged command.",
          {
            command: z.string().min(1),
            args: z.array(z.union([z.string(), z.number()])).optional()
          },
          async ({ command, args = [] }) => {
            try {
              const ctx = await getClient();
              const { name, info } = await commandInfo(ctx, command, args[0]);
              const access = classifyCommand(name, info);
              if (access.blocked) return errorResult(access.blocked);
              if (!operationAccess[access === "read" ? "query" : "write"]) {
                return errorResult(`${name} 是${access === "read" ? "讀取" : "寫入"}指令，此 instance 未開放`);
              }
              return limitedJson(await ctx.client.call(command, ...args.map(String)));
            } catch (err) {
              return errorResult(`指令失敗: ${err.message}`);
            }
          }
        );
      }
    }
  };
}
