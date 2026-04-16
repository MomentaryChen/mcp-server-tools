import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";

// Create MCP server.
const server = new McpServer({ name: "file-tools", version: "1.0.0" });

// Tool: Read file.
server.tool(
  "readFile",
  { path: z.string() }, // Accept file path.
  async ({ path }) => {
    try {
      const content = await fs.readFile(path, "utf-8");
      return { content: [{ type: "text", text: content }] };
    } catch (err) {
      return { content: [{ type: "text", text: `讀取失敗: ${err.message}` }] };
    }
  }
);

// Connect to Cursor via stdin/stdout.
const transport = new StdioServerTransport();
await server.connect(transport);

console.log("✅ MCP Server 已啟動，readFile tool 可使用");