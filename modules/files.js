import { z } from "zod";
import fs from "fs/promises";
import { realpathSync } from "fs";
import nodePath from "path";
import { positiveInt } from "../lib/common.js";

const DEFAULT_MAX_BYTES = 200000;
const DEFAULT_MAX_BYTES_LIMIT = 2000000;

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

// FILES_ROOTS: directories separated by the OS path delimiter (";" on Windows, ":" elsewhere).
// Each root is resolved to its real path once, so a symlinked root still matches.
export function parseRoots(value) {
  if (!value?.trim()) return [];
  return value
    .split(nodePath.delimiter)
    .map((root) => root.trim())
    .filter(Boolean)
    .map((root) => {
      try {
        return realpathSync.native(nodePath.resolve(root)); // native: same result as fs.promises.realpath (expands 8.3 names)
      } catch (err) {
        throw new Error(`FILES_ROOTS 目錄不存在或無法存取: ${root} (${err.message})`);
      }
    });
}

// Real path of target (symlinks resolved, so a link can't point outside a root). With roots
// configured, the path must be one of them or inside one; with no roots every path is allowed.
export async function resolveAllowedPath(target, roots) {
  const real = await fs.realpath(nodePath.resolve(target));
  if (roots.length === 0) return real;
  for (const root of roots) {
    // path.relative compares case-insensitively on Windows.
    const rel = nodePath.relative(root, real);
    if (rel === "" || (rel !== ".." && !rel.startsWith(`..${nodePath.sep}`) && !nodePath.isAbsolute(rel))) {
      return real;
    }
  }
  throw new Error(`不允許讀取此路徑（不在 FILES_ROOTS 內）: ${target}`);
}

export default function create({ env = {} } = {}) {
  const roots = parseRoots(env.FILES_ROOTS);
  const maxBytesLimit = positiveInt(env.FILES_MAX_BYTES, DEFAULT_MAX_BYTES_LIMIT);
  const defaultMaxBytes = Math.min(DEFAULT_MAX_BYTES, maxBytesLimit);

  if (roots.length === 0) {
    console.error("⚠️ file-tools: 未設定 FILES_ROOTS，readFile 可讀取任何本機檔案");
  }
  const scope = roots.length > 0 ? ` Only files under these directories can be read: ${roots.join(", ")}.` : "";

  return {
    info: { name: "file-tools", version: "1.1.0" },

    register(server) {
      // Tool: Read file.
      server.tool(
        "readFile",
        `Read a local text file as UTF-8. Returns at most maxBytes bytes (default ${defaultMaxBytes}, max ${maxBytesLimit}); a longer file is cut and ends with a truncation note.${scope}`,
        {
          path: z.string(),
          maxBytes: z
            .number()
            .int()
            .positive()
            .max(maxBytesLimit)
            .optional()
            .describe(`Maximum bytes to read (default ${defaultMaxBytes}, max ${maxBytesLimit})`)
        },
        async ({ path, maxBytes = defaultMaxBytes }) => {
          try {
            const realPath = await resolveAllowedPath(path, roots);
            const { text, size, truncated } = await readFileLimited(realPath, maxBytes);
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
