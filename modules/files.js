import { z } from "zod";
import fs from "fs/promises";

const DEFAULT_MAX_BYTES = 200000;

// Read at most maxBytes bytes of a UTF-8 file. Returns { text, size, truncated }; a multi-byte
// character cut at the limit is dropped rather than decoded as garbage.
export async function readFileLimited(path, maxBytes) {
  const handle = await fs.open(path, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const truncated = size > offset;
    const text = new TextDecoder("utf-8").decode(buffer.subarray(0, offset), { stream: truncated });
    return { text, size, truncated };
  } finally {
    await handle.close();
  }
}

export default function create() {
  return {
    info: { name: "file-tools", version: "1.0.0" },

    register(server) {
      // Tool: Read file.
      server.tool(
        "readFile",
        `Read a local text file as UTF-8. Returns at most maxBytes bytes (default ${DEFAULT_MAX_BYTES}); a longer file is cut and ends with a truncation note.`,
        {
          path: z.string(),
          maxBytes: z.number().int().positive().optional().describe(`Maximum bytes to read (default ${DEFAULT_MAX_BYTES})`)
        },
        async ({ path, maxBytes = DEFAULT_MAX_BYTES }) => {
          try {
            const { text, size, truncated } = await readFileLimited(path, maxBytes);
            const content = truncated ? `${text}\n\n[已截斷：僅顯示前 ${maxBytes} / ${size} bytes，可用 maxBytes 參數讀取更多]` : text;
            return { content: [{ type: "text", text: content }] };
          } catch (err) {
            return { content: [{ type: "text", text: `讀取失敗: ${err.message}` }], isError: true };
          }
        }
      );
    }
  };
}
