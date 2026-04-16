import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mysql from "mysql2/promise";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "./scripts/ssh-tunnel.js";

// Load environment variables from .env (can be overridden with ENV_FILE).
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
  MYSQL_DELETE_OPERATION = "true"
} = process.env;

const mysqlPort = parseInt(MYSQL_PORT, 10);
const sshConfig = getSshConfigFromEnv(process.env, "MYSQL");

if (!MYSQL_USER || !MYSQL_DATABASE) {
  console.error("❌ 請在 .env 或環境變數中設定 MYSQL_USER、MYSQL_DATABASE（MYSQL_PASSWORD 可為空）");
  process.exit(1);
}

let db;

if (useSshTunnel(sshConfig)) {
  const tunnelTarget = await createSshForwardTunnel({
    sshConfig,
    dstAddr: MYSQL_HOST,
    dstPort: mysqlPort
  });

  db = mysql.createPool({
    host: tunnelTarget.host,
    port: tunnelTarget.port,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE
  });
  console.error(`✅ MCP MySQL Server 已啟動（經 SSH 通道，jump hops: ${sshConfig.jumps.length}）`);
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

function assertReadOnlyQuery(sql) {
  const trimmedSql = String(sql || "").trim();
  if (!trimmedSql) {
    throw new Error("SQL 不可為空");
  }

  // Allow only read-only SQL to prevent bypassing write-operation controls via query_mysql.
  const readOnlyPrefixPattern = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
  if (!readOnlyPrefixPattern.test(trimmedSql)) {
    throw new Error("Operation not allowed: query_mysql only allows read-only SQL");
  }
}

server.tool(
  "query_mysql",
  { sql: z.string() },
  async ({ sql }) => {
    assertOperationAllowed("query_mysql", operationAccess.query);
    assertReadOnlyQuery(sql);
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
