import { z } from "zod";
import fs from "fs/promises";

export default function create() {
  return {
    info: { name: "file-tools", version: "1.0.0" },

    register(server) {
      // Tool: Read file.
      server.tool(
        "readFile",
        { path: z.string() },
        async ({ path }) => {
          try {
            const content = await fs.readFile(path, "utf-8");
            return { content: [{ type: "text", text: content }] };
          } catch (err) {
            return { content: [{ type: "text", text: `讀取失敗: ${err.message}` }] };
          }
        }
      );
    }
  };
}
