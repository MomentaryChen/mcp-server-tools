import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";

// 建立 MCP Server
const server = new McpServer({ name: "file-tools", version: "1.0.0" });

// Tool：讀檔案
server.tool(
  "readFile",
  { path: z.string() }, // 接收檔案路徑
  async ({ path }) => {
    try {
      const content = await fs.readFile(path, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return { content: [{ type: "text", text: `讀取失敗: ${err.message}` }] };
    }
  }
);

// 使用 stdin/stdout 連接 Cursor
const transport = new StdioServerTransport();
await server.connect(transport);

console.log("✅ MCP Server 已啟動，readFile tool 可使用");