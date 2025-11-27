import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import pkg from "mongodb";
const { MongoClient } = pkg;

// 🔗 MongoDB 連線設定
const uri = "mongodb://victor:zxcv1234@127.0.0.1:27017"; // 改成你的 MongoDB URI
const client = new MongoClient(uri);
await client.connect();
const db = client.db("actiontec"); // 改成你的資料庫名稱

// 建立 MCP Server
const server = new McpServer({ name: "mongo_db-tools", version: "1.0.0" });

// 🛠 工具 1：查詢
server.tool(
  "query_mongo",
  {
    collection: z.string(),
    query: z.any().optional()
  },
  async ({ collection, query }) => {
    try {
      const coll = db.collection(collection);
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
      const coll = db.collection(collection);
      const result = await coll.deleteMany(filter);
      return { content: [{ type: "text", text: `刪除成功, deleted: ${result.deletedCount}` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `刪除失敗: ${err.message}` }] };
    }
  }
);

// 🛠 工具 5：列出所有集合
server.tool(
  "list_mongo_collections",
  {},
  async () => {
    try {
      const collections = await db.listCollections().toArray();
      const collectionNames = collections.map(col => col.name);
      return { content: [{ type: "text", text: JSON.stringify(collectionNames, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `查詢失敗: ${err.message}` }] };
    }
  }
);

// 使用 stdin/stdout 連接 Cursor
const transport = new StdioServerTransport();
await server.connect(transport);

console.log("✅ MCP Server 已啟動，mongo_db-tools 可使用");