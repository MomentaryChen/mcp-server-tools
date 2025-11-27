import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";

// 🔗 DB 連線設定（改成你的設定）
const db = await mysql.createPool({
  host: "127.0.0.1",
  user: "root",
  password: "root123456",
  database: "actiontec"
});

const server = new McpServer({ name: "mysql-tools", version: "1.0.0" });

// 🛠 Tool：執行 SQL 查詢
server.tool(
  "query_mysql",
  { sql: z.string() },
  async ({ sql }) => {
    const [rows] = await db.query(sql);
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);