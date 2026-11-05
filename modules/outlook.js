import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import { errorResult, jsonResult } from "../lib/common.js";
import { OutlookWorker } from "../lib/outlook-worker.js";

const scriptPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "outlook.ps1");

export default function create({ env }) {
  const {
    OUTLOOK_POWERSHELL = "powershell.exe",
    OUTLOOK_TIMEOUT_MS = "120000",
    OUTLOOK_IDLE_MS = "600000",
    OUTLOOK_MAX_BODY_CHARS = "20000"
  } = env;

  if (process.platform !== "win32") {
    throw new Error("outlook 模組只支援 Windows（需要本機傳統版 Outlook 的 COM 介面）");
  }

  const maxBodyChars = parseInt(OUTLOOK_MAX_BODY_CHARS, 10);

  // One persistent PowerShell worker per module instance (shared by all gateway sessions).
  const worker = new OutlookWorker({
    command: OUTLOOK_POWERSHELL,
    scriptPath,
    timeoutMs: parseInt(OUTLOOK_TIMEOUT_MS, 10),
    idleMs: parseInt(OUTLOOK_IDLE_MS, 10),
    env
  });

  async function run(action, params) {
    try {
      return jsonResult(await worker.request(action, params));
    } catch (err) {
      return errorResult(`Outlook 讀取失敗: ${err.message}`);
    }
  }

  return {
    info: { name: "outlook-tools", version: "1.0.0" },

    async close() {
      worker.stop();
    },

    register(server) {
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
        async () => run("status")
      );

      server.tool(
        "outlook_list_folders",
        "列出郵件資料夾樹（含封數與未讀數）",
        {
          folder: folderSchema.describe("起始資料夾（預設為整個信箱）"),
          maxDepth: z.number().int().min(1).max(20).optional().describe("最大層數（預設 10）")
        },
        async (params) => run("list_folders", params)
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
        async (params) => run("list_messages", params)
      );

      server.tool(
        "outlook_search_messages",
        "依關鍵字搜尋郵件（主旨 / 寄件者 / 內文）。未指定 folder 時搜尋整個信箱（不含刪除的郵件與垃圾郵件）",
        {
          query: z.string().optional().describe("關鍵字（不分大小寫）。純英數關鍵字走索引、比對字首；含中文或標點則為子字串比對"),
          field: z.enum(["all", "subject", "from", "body"]).optional().describe("搜尋欄位（預設 all）"),
          folder: folderSchema,
          includeSubfolders: z.boolean().optional().describe("指定 folder 時是否包含子資料夾"),
          since: dateSchema,
          until: dateSchema,
          unreadOnly: z.boolean().optional(),
          limit: limitSchema
        },
        async (params) => run("search_messages", params)
      );

      server.tool(
        "outlook_get_message",
        "以 id（EntryID，來自 list / search 結果）讀取單封郵件完整內容：收件者、內文、附件清單",
        {
          id: z.string().describe("郵件 EntryID"),
          maxBodyChars: z.number().int().min(100).optional().describe(`內文最多字元數（預設 ${maxBodyChars}）`)
        },
        async ({ id, maxBodyChars: limit }) => run("get_message", { id, maxBodyChars: limit ?? maxBodyChars })
      );
    }
  };
}
