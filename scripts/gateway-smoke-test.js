// Smoke test for gateway.js: connect to every instance, list tools, and run a few read-only calls.
// Usage: node scripts/gateway-smoke-test.js [baseUrl] [instance:tool:jsonArgs ...]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://127.0.0.1:3800";
const calls = process.argv.slice(3).map((spec) => {
  const [instance, tool, ...rest] = spec.split(":");
  return { instance, tool, args: rest.length ? JSON.parse(rest.join(":")) : {} };
});

const status = await (await fetch(`${base}/health`)).json();
let failed = 0;

for (const instance of status.instances) {
  if (instance.error) {
    console.log(`✗ ${instance.name}: load error: ${instance.error}`);
    failed++;
    continue;
  }
  const client = new Client({ name: "smoke-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(instance.url)));
    const { tools } = await client.listTools();
    console.log(`✓ ${instance.name}: ${tools.map((t) => t.name).join(", ")}`);

    for (const call of calls.filter((c) => c.instance === instance.name)) {
      const result = await client.callTool({ name: call.tool, arguments: call.args });
      const text = result.content?.map((c) => c.text).join("\n") ?? "";
      console.log(`  ${result.isError ? "✗" : "→"} ${call.tool}: ${text.slice(0, 200).replace(/\s+/g, " ")}`);
    }
    await client.close();
  } catch (err) {
    console.log(`✗ ${instance.name}: ${err.message}`);
    failed++;
  }
}

process.exit(failed ? 1 : 0);
