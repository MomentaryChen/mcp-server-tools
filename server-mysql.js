import dotenv from "dotenv";
import { readFileSync } from "fs";
import { createTunnel } from "tunnel-ssh";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";

// 透過 .env 載入變數（可透過 ENV_FILE 指定路徑，預設為專案根目錄的 .env）
dotenv.config({ path: process.env.ENV_FILE || ".env" });

const {
  MYSQL_HOST = "127.0.0.1",
  MYSQL_PORT = "3306",
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
  MYSQL_REMOTE_HOST = "127.0.0.1",
  SSH_HOST,
  SSH_PORT = "22",
  SSH_USER,
  SSH_PASSWORD,
  SSH_PRIVATE_KEY_PATH,
  SSH_PRIVATE_KEY
} = process.env;

const mysqlPort = parseInt(MYSQL_PORT, 10);
const sshPort = parseInt(SSH_PORT, 10);

if (!MYSQL_USER || !MYSQL_DATABASE) {
  console.error("❌ 請在 .env 或環境變數中設定 MYSQL_USER、MYSQL_DATABASE（MYSQL_PASSWORD 可為空）");
  process.exit(1);
}

/** 是否啟用 SSH 通道：.env 有填 SSH 相關資訊才啟用 */
function useSshTunnel() {
  const hasSshHost = Boolean(SSH_HOST?.trim());
  const hasSshUser = Boolean(SSH_USER?.trim());
  const hasSshAuth =
    Boolean(SSH_PASSWORD?.trim()) ||
    Boolean(SSH_PRIVATE_KEY_PATH?.trim()) ||
    Boolean(SSH_PRIVATE_KEY?.trim());
  return hasSshHost && hasSshUser && hasSshAuth;
}

function buildSshOptions() {
  const options = {
    host: SSH_HOST,
    port: sshPort,
    username: SSH_USER
  };
  if (SSH_PASSWORD?.trim()) {
    options.password = SSH_PASSWORD;
  } else if (SSH_PRIVATE_KEY?.trim()) {
    options.privateKey = SSH_PRIVATE_KEY.replace(/\\n/g, "\n");
  } else if (SSH_PRIVATE_KEY_PATH?.trim()) {
    const path = SSH_PRIVATE_KEY_PATH.replace(/^~/, process.env.HOME || process.env.USERPROFILE || "");
    options.privateKey = readFileSync(path, "utf8");
  }
  return options;
}

let db;

if (useSshTunnel()) {
  const tunnelOptions = { autoClose: false, reconnectOnError: false };
  const serverOptions = { host: "127.0.0.1", port: 0 };
  const sshOptions = buildSshOptions();
  const forwardOptions = {
    dstAddr: MYSQL_REMOTE_HOST,
    dstPort: mysqlPort
  };

  const [tunnelServer] = await createTunnel(
    tunnelOptions,
    serverOptions,
    sshOptions,
    forwardOptions
  );
  const localPort = tunnelServer.address().port;

  db = mysql.createPool({
    host: "127.0.0.1",
    port: localPort,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE
  });
  console.error(`✅ MCP MySQL Server 已啟動（經 SSH 通道 ${SSH_HOST}:${sshPort}）`);
} else {
  db = mysql.createPool({
    host: MYSQL_HOST,
    port: mysqlPort,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE
  });
  console.error("✅ MCP MySQL Server 已啟動（直連）");
}

const server = new McpServer({ name: "mysql-tools", version: "2.0.0" });

server.tool(
  "query_mysql",
  { sql: z.string() },
  async ({ sql }) => {
    const [rows] = await db.query(sql);
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
