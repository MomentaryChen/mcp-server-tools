import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from "url";

// Load environment variables from .env (can be overridden with ENV_FILE).
dotenv.config({ path: process.env.ENV_FILE || ".env" });

const {
  OUTLOOK_POWERSHELL = "powershell.exe",
  OUTLOOK_TIMEOUT_MS = "120000",
  OUTLOOK_MAX_BODY_CHARS = "20000"
} = process.env;

if (process.platform !== "win32") {
  console.error("❌ server-outlook.js 只支援 Windows（需要本機傳統版 Outlook 的 COM 介面）");
  process.exit(1);
}

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "outlook.ps1");
const timeoutMs = parseInt(OUTLOOK_TIMEOUT_MS, 10);
const maxBodyChars = parseInt(OUTLOOK_MAX_BODY_CHARS, 10);

// Run one read-only action in scripts/outlook.ps1 and return its `data`.
function runOutlook(action, params = {}) {
  const paramsB64 = Buffer.from(JSON.stringify(params), "utf-8").toString("base64");
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, action, paramsB64];

  return new Promise((resolve, reject) => {
    execFile(
      OUTLOOK_POWERSHELL,
      args,
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout, stderr) => {
        const out = (stdout || "").trim();
        if (!out) {
          reject(new Error(err?.message || stderr || "Outlook script returned no output"));
          return;
        }
        try {
          const result = JSON.parse(out.slice(out.indexOf("{")));
          if (result.ok) {
            resolve(result.data);
          } else {
            reject(new Error(result.error));
          }
        } catch (parseErr) {
          reject(new Error(`無法解析 Outlook 輸出: ${parseErr.message}\n${out.slice(0, 500)}`));
        }
      }
    );
  });
}

function asText(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function asError(err) {
  return { content: [{ type: "text", text: `Outlook 讀取失敗: ${err.message}` }], isError: true };
}

const server = new McpServer({ name: "outlook-tools", version: "1.0.0" });

const folderSchema = z
  .string()
  .optional()
  .describe("資料夾路徑，以 / 分隔，例如 'Inbox'、'Projects/Optim 6'。可用 inbox / sent / drafts / deleted / junk 代表預設資料夾");
const dateSchema = z.string().optional().describe("ISO 日期或時間（本機時區），例如 '2026-10-01' 或 '2026-10-01T09:00'");
const limitSchema = z.number().int().min(1).max(200).optional().describe("最多回傳筆數（預設 20）");

server.tool(
  "outlook_status",
  "檢查 Outlook 連線狀態、帳號與信箱",
  {},
  async () => {
    try {
      return asText(await runOutlook("status"));
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "outlook_list_folders",
  "列出郵件資料夾樹（含封數與未讀數）",
  {
    folder: folderSchema.describe("起始資料夾（預設為整個信箱）"),
    maxDepth: z.number().int().min(1).max(20).optional().describe("最大層數（預設 10）")
  },
  async (params) => {
    try {
      return asText(await runOutlook("list_folders", params));
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "outlook_list_messages",
  "列出資料夾中的郵件摘要（依收件時間新到舊）",
  {
    folder: folderSchema,
    since: dateSchema,
    until: dateSchema,
    unreadOnly: z.boolean().optional().describe("只列出未讀"),
    limit: limitSchema
  },
  async (params) => {
    try {
      return asText(await runOutlook("list_messages", params));
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "outlook_search_messages",
  "依關鍵字搜尋郵件（主旨 / 寄件者 / 內文）。未指定 folder 時搜尋整個信箱（不含刪除的郵件與垃圾郵件）",
  {
    query: z.string().optional().describe("關鍵字（子字串比對，不分大小寫）"),
    field: z.enum(["all", "subject", "from", "body"]).optional().describe("搜尋欄位（預設 all）"),
    folder: folderSchema,
    includeSubfolders: z.boolean().optional().describe("指定 folder 時是否包含子資料夾"),
    since: dateSchema,
    until: dateSchema,
    unreadOnly: z.boolean().optional(),
    limit: limitSchema
  },
  async (params) => {
    try {
      return asText(await runOutlook("search_messages", params));
    } catch (err) {
      return asError(err);
    }
  }
);

server.tool(
  "outlook_get_message",
  "以 id（EntryID，來自 list / search 結果）讀取單封郵件完整內容：收件者、內文、附件清單",
  {
    id: z.string().describe("郵件 EntryID"),
    maxBodyChars: z.number().int().min(100).optional().describe(`內文最多字元數（預設 ${maxBodyChars}）`)
  },
  async ({ id, maxBodyChars: limit }) => {
    try {
      return asText(await runOutlook("get_message", { id, maxBodyChars: limit ?? maxBodyChars }));
    } catch (err) {
      return asError(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error("✅ MCP Outlook Server 已啟動（唯讀，透過本機 Outlook COM）");
