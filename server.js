import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const server = new McpServer({ name: "demo", version: "1.0.0" });

server.tool("say_hello",
  { name: z.string() },
  async ({ name }) => ({
    content: [{ type: "text", text: `Hello, ${name}!, mpc server responded` }]
  })
);

server.tool("check_health",
  {},
  async () => ({
    content: [{ type: "text", text: "Server is healthy and running" }]
  })
);

// 用 stdin/stdout transport
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
const transport = new StdioServerTransport();
await server.connect(transport);