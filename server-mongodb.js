import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "./scripts/ssh-tunnel.js";

import pkg from "mongodb";
const { MongoClient } = pkg;

// Load environment variables from .env (can be overridden with ENV_FILE).
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
  MONGO_LIST_COLLECTIONS_OPERATION = "true"
} = process.env;

const mongoPort = parseInt(MONGO_PORT, 10);
const sshConfig = getSshConfigFromEnv(process.env, "MONGO");

if (Number.isNaN(mongoPort)) {
  console.error("❌ MONGO_PORT 不是有效數字，請檢查 .env 設定");
  process.exit(1);
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

if (useSshTunnel(sshConfig)) {
  const tunnelTarget = await createSshForwardTunnel({
    sshConfig,
    dstAddr: MONGO_HOST,
    dstPort: mongoPort
  });

  client = buildMongoClient(tunnelTarget.host, tunnelTarget.port);
  console.error(`✅ 已建立 Mongo SSH 通道（jump hops: ${sshConfig.jumps.length} -> ${MONGO_HOST}:${mongoPort}）`);
} else {
  client = buildMongoClient(MONGO_HOST, mongoPort);
}

await client.connect();
const db = client.db(MONGO_DATABASE);

console.error(`✅ MCP MongoDB Server 已啟動（database: ${MONGO_DATABASE}）`);

const server = new McpServer({ name: "mongo_db-tools", version: "1.0.0" });

// Tool 1: Query (optional database, defaults to MONGO_DATABASE).
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

// Tool 2: Insert.
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

// Tool 3: Update.
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

// Tool 4: Delete.
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

// Tool 5: List all collections (optional database, defaults to MONGO_DATABASE).
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