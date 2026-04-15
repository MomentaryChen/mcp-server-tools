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
  MYSQL_QUERY_OPERATION = "true",
  MYSQL_INSERT_OPERATION = "true",
  MYSQL_UPDATE_OPERATION = "true",
  MYSQL_DELETE_OPERATION = "true",
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
    dstAddr: MYSQL_HOST,
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
const sqlValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sqlRecordSchema = z.record(z.string(), sqlValueSchema);

function toSafeIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

function buildWhereClause(where) {
  const entries = Object.entries(where);
  if (entries.length === 0) {
    throw new Error("WHERE 條件不可為空");
  }

  const clauses = [];
  const params = [];

  for (const [column, value] of entries) {
    const safeColumn = toSafeIdentifier(column);
    if (value === null) {
      clauses.push(`${safeColumn} IS NULL`);
    } else {
      clauses.push(`${safeColumn} = ?`);
      params.push(value);
    }
  }

  return { clause: clauses.join(" AND "), params };
}

function parseBooleanFlag(value, defaultValue = true) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

const operationAccess = {
  query: parseBooleanFlag(MYSQL_QUERY_OPERATION, true),
  insert: parseBooleanFlag(MYSQL_INSERT_OPERATION, true),
  update: parseBooleanFlag(MYSQL_UPDATE_OPERATION, true),
  delete: parseBooleanFlag(MYSQL_DELETE_OPERATION, true)
};

function assertOperationAllowed(operationName, allowed) {
  if (!allowed) {
    throw new Error(`Operation not allowed: ${operationName}`);
  }
}

server.tool(
  "query_mysql",
  { sql: z.string() },
  async ({ sql }) => {
    assertOperationAllowed("query_mysql", operationAccess.query);
    const [rows] = await db.query(sql);
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }]
    };
  }
);

server.tool(
  "insert_mysql",
  {
    table: z.string(),
    data: sqlRecordSchema
  },
  async ({ table, data }) => {
    assertOperationAllowed("insert_mysql", operationAccess.insert);
    const entries = Object.entries(data);
    if (entries.length === 0) {
      throw new Error("data 不可為空");
    }

    const safeTable = toSafeIdentifier(table);
    const columns = entries.map(([column]) => toSafeIdentifier(column));
    const values = entries.map(([, value]) => value);
    const placeholders = entries.map(() => "?").join(", ");

    const sql = `INSERT INTO ${safeTable} (${columns.join(", ")}) VALUES (${placeholders})`;
    const [result] = await db.execute(sql, values);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "insert success",
              affectedRows: result.affectedRows,
              insertId: result.insertId
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "update_mysql",
  {
    table: z.string(),
    data: sqlRecordSchema,
    where: sqlRecordSchema
  },
  async ({ table, data, where }) => {
    assertOperationAllowed("update_mysql", operationAccess.update);
    const dataEntries = Object.entries(data);
    if (dataEntries.length === 0) {
      throw new Error("data 不可為空");
    }

    const safeTable = toSafeIdentifier(table);
    const setClauses = [];
    const setParams = [];

    for (const [column, value] of dataEntries) {
      const safeColumn = toSafeIdentifier(column);
      if (value === null) {
        setClauses.push(`${safeColumn} = NULL`);
      } else {
        setClauses.push(`${safeColumn} = ?`);
        setParams.push(value);
      }
    }

    const { clause: whereClause, params: whereParams } = buildWhereClause(where);
    const sql = `UPDATE ${safeTable} SET ${setClauses.join(", ")} WHERE ${whereClause}`;
    const [result] = await db.execute(sql, [...setParams, ...whereParams]);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "update success",
              affectedRows: result.affectedRows,
              changedRows: result.changedRows
            },
            null,
            2
          )
        }
      ]
    };
  }
);

server.tool(
  "delete_mysql",
  {
    table: z.string(),
    where: sqlRecordSchema,
    limit: z.number().int().positive().optional()
  },
  async ({ table, where, limit }) => {
    assertOperationAllowed("delete_mysql", operationAccess.delete);
    const safeTable = toSafeIdentifier(table);
    const { clause: whereClause, params } = buildWhereClause(where);
    const safeLimit = limit ?? 1;
    const sql = `DELETE FROM ${safeTable} WHERE ${whereClause} LIMIT ${safeLimit}`;
    const [result] = await db.execute(sql, params);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              message: "delete success",
              affectedRows: result.affectedRows
            },
            null,
            2
          )
        }
      ]
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
