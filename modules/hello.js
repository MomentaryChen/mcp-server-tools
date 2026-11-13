import { z } from "zod";

export default function create() {
  return {
    info: { name: "demo", version: "1.0.0" },

    register(server) {
      server.tool("say_hello",
        "Return a greeting for the given name (connectivity test).",
        { name: z.string() },
        async ({ name }) => ({
          content: [{ type: "text", text: `Hello, ${name}!, mpc server responded` }]
        })
      );

      server.tool("check_health",
        "Report that the MCP server is running.",
        {},
        async () => ({
          content: [{ type: "text", text: "Server is healthy and running" }]
        })
      );
    }
  };
}
