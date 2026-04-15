import dotenv from "dotenv";
import { readFileSync } from "fs";
import { createTunnel } from "tunnel-ssh";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import pkg from "mongodb";
const { MongoClient } = pkg;

// 透過 .env 載入變數（可透過 ENV_FILE 指定路徑，預設為專案根目錄的 .env）
dotenv.config({ path: process.env.ENV_FILE || ".env" });

const {
  MONGO_HOST = "127.0.0.1",
  MONGO_PORT = "27017",
  MONGO_USER,
  MONGO_PASSWORD,
  MONGO_DATABASE = "test",
  MONGO_AUTH_SOURCE,
  MONGO_AUTH_MECHANISM,
  MONGO_QUERY_OPERATION = "true",
  MONGO_INSERT_OPERATION = "true",
  MONGO_UPDATE_OPERATION = "true",
  MONGO_DELETE_OPERATION = "true",
  MONGO_LIST_COLLECTIONS_OPERATION = "true",
  SSH_HOST,
  SSH_PORT = "22",
  SSH_USER,
  SSH_PASSWORD,
  SSH_PRIVATE_KEY_PATH,
  SSH_PRIVATE_KEY
} = process.env;

const mongoPort = parseInt(MONGO_PORT, 10);
const sshPort = parseInt(SSH_PORT, 10);

if (Number.isNaN(mongoPort)) {
  console.error("❌ MONGO_PORT 不是有效數字，請檢查 .env 設定");
  process.exit(1);
}

/** 是否啟用 SSH 通道：.env 有填 SSH 相關資訊才啟用 */
function useSshTunnel() {
  const hasSshHost = Boolean(SSH_HOST?.trim());
  const hasSshUser = Boolean(SSH_USER?.trim());
  const hasSshAuth =
    Boolean(SSH_PASSWORD?.trim()) ||
    Boolean(SSH_PRIVATE_KEY_PATH?.trim()) ||
    Boolean(SSH_PRIVATE_KEY?.trim());
  return hasSshHost && hasSshUser && hasSshAuth;
}

function buildSshOptions() {
  const options = {
    host: SSH_HOST,
    port: sshPort,
    username: SSH_USER
  };
  if (SSH_PASSWORD?.trim()) {
    options.password = SSH_PASSWORD;
  } else if (SSH_PRIVATE_KEY?.trim()) {
    options.privateKey = SSH_PRIVATE_KEY.replace(/\\n/g, "\n");
  } else if (SSH_PRIVATE_KEY_PATH?.trim()) {
    const path = SSH_PRIVATE_KEY_PATH.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
    options.privateKey = readFileSync(path, "utf8");
  }
  return options;
}

function buildMongoClient(host, port) {
  const options = {};
  if (MONGO_USER?.trim()) {
    options.auth = {
      username: MONGO_USER,
      password: MONGO_PASSWORD || ""
    };
    options.authSource = MONGO_AUTH_SOURCE?.trim() || MONGO_DATABASE;
  }
  if (MONGO_AUTH_MECHANISM?.trim()) {
    options.authMechanism = MONGO_AUTH_MECHANISM;
  }
  return new MongoClient(`mongodb://${host}:${port}`, options);
}

function parseBooleanFlag(value, defaultValue = true) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

const operationAccess = {
  query: parseBooleanFlag(MONGO_QUERY_OPERATION, true),
  insert: parseBooleanFlag(MONGO_INSERT_OPERATION, true),
  update: parseBooleanFlag(MONGO_UPDATE_OPERATION, true),
  delete: parseBooleanFlag(MONGO_DELETE_OPERATION, true),
  listCollections: parseBooleanFlag(MONGO_LIST_COLLECTIONS_OPERATION, true)
};

function assertOperationAllowed(operationName, allowed) {
  if (!allowed) {
    throw new Error(`Operation not allowed: ${operationName}`);
  }
}

let client;

if (useSshTunnel()) {
  const tunnelOptions = { autoClose: false, reconnectOnError: false };
  const serverOptions = { host: "127.0.0.1", port: 0 };
  const sshOptions = buildSshOptions();
  const forwardOptions = {
    dstAddr: MONGO_HOST,
    dstPort: mongoPort
  };

  const [tunnelServer] = await createTunnel(
    tunnelOptions,
    serverOptions,
    sshOptions,
    forwardOptions
  );
  const localPort = tunnelServer.address().port;

  client = buildMongoClient("127.0.0.1", localPort);
  console.error(`✅ 已建立 Mongo SSH 通道（${SSH_HOST}:${sshPort} -> ${MONGO_HOST}:${mongoPort}）`);
} else {
  client = buildMongoClient(MONGO_HOST, mongoPort);
}

await client.connect();
const db = client.db(MONGO_DATABASE);

console.error(`✅ MCP MongoDB Server 已啟動（database: ${MONGO_DATABASE}）`);

const server = new McpServer({ name: "mongo_db-tools", version: "1.0.0" });

// 🛠 工具 1：查詢（可選 database，未填則用 MONGO_DATABASE）
server.tool(
  "query_mongo",
  {
    collection: z.string(),
    query: z.any().optional(),
    database: z.string().optional()
  },
  async ({ collection, query, database }) => {
    try {
      assertOperationAllowed("query_mongo", operationAccess.query);
      const targetDb = client.db(database || MONGO_DATABASE);
      const coll = targetDb.collection(collection);
      const result = await coll.find(query || {}).limit(50).toArray();
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `查詢失敗: ${err.message}` }] };
    }
  }
);

// 🛠 工具 2：插入
server.tool(
  "mongo_insert",
  {
    collection: z.string(),
    document: z.any()
  },
  async ({ collection, document }) => {
    try {
      assertOperationAllowed("mongo_insert", operationAccess.insert);
      const coll = db.collection(collection);
      const result = await coll.insertOne(document);
      return { content: [{ type: "text", text: `插入成功, id: ${result.insertedId}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `插入失敗: ${err.message}` }] };
    }
  }
);

// 🛠 工具 3：更新
server.tool(
  "mongo_update",
  {
    collection: z.string(),
    filter: z.any(),
    update: z.any()
  },
  async ({ collection, filter, update }) => {
    try {
      assertOperationAllowed("mongo_update", operationAccess.update);
      const coll = db.collection(collection);
      const result = await coll.updateMany(filter, { $set: update });
      return { content: [{ type: "text", text: `更新成功, matched: ${result.matchedCount}, modified: ${result.modifiedCount}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `更新失敗: ${err.message}` }] };
    }
  }
);

// 🛠 工具 4：刪除
server.tool(
  "mongo_delete",
  {
    collection: z.string(),
    filter: z.any()
  },
  async ({ collection, filter }) => {
    try {
      assertOperationAllowed("mongo_delete", operationAccess.delete);
      const coll = db.collection(collection);
      const result = await coll.deleteMany(filter);
      return { content: [{ type: "text", text: `刪除成功, deleted: ${result.deletedCount}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `刪除失敗: ${err.message}` }] };
    }
  }
);

// 🛠 工具 5：列出所有集合（可選 database，未填則用 MONGO_DATABASE）
server.tool(
  "list_mongo_collections",
  { database: z.string().optional() },
  async ({ database }) => {
    try {
      assertOperationAllowed("list_mongo_collections", operationAccess.listCollections);
      const targetDb = client.db(database || MONGO_DATABASE);
      const collections = await targetDb.listCollections().toArray();
      const collectionNames = collections.map(col => col.name);
      return { content: [{ type: "text", text: JSON.stringify(collectionNames, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `查詢失敗: ${err.message}` }] };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);