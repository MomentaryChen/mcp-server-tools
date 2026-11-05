// Standalone stdio MCP server (one process per client). For a shared process, use gateway.js.
import create from "./modules/mongodb.js";
import { runStdio } from "./lib/stdio.js";

await runStdio(create);
