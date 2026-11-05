import path from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvFile } from "./common.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Run one module as a classic stdio MCP server (one process per client).
// Env: values from ENV_FILE (default <project>/.env), overridden by the real process environment.
export async function runStdio(createModule) {
  const env = { ...loadEnvFile(process.env.ENV_FILE || path.join(rootDir, ".env")), ...process.env };
  let mod;
  try {
    mod = createModule({ env, argv: process.argv.slice(2) });
    await mod.warmup?.();
  } catch (err) {
    console.error(`❌ MCP server 啟動失敗: ${err.message}`);
    process.exit(1);
  }

  const server = new McpServer(mod.info);
  mod.register(server);
  await server.connect(new StdioServerTransport());
  console.error(`✅ MCP ${mod.info.name} 已啟動（stdio）`);
}
