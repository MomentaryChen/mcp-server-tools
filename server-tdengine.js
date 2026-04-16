import dotenv from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "./scripts/ssh-tunnel.js";

// Load environment variables from .env (can be overridden with ENV_FILE).
dotenv.config({ path: process.env.ENV_FILE || ".env" });

const {
  TDENGINE_HOST = "127.0.0.1",
  TDENGINE_PORT = "6041",
  TDENGINE_USER = "root",
  TDENGINE_PASSWORD = "taosdata",
  TDENGINE_QUERY_OPERATION = "true",
  TDENGINE_INSERT_OPERATION = "true",
  TDENGINE_UPDATE_OPERATION = "true",
  TDENGINE_DELETE_OPERATION = "true"
} = process.env;

const tdenginePort = parseInt(TDENGINE_PORT, 10);
const sshConfig = getSshConfigFromEnv(process.env, "TDENGINE");

async function buildTdengineConfig() {
  if (!useSshTunnel(sshConfig)) {
    console.error(`✅ MCP TDengine Server 已啟動（直連 ${TDENGINE_HOST}:${tdenginePort}）`);
    return {
      host: TDENGINE_HOST,
      port: tdenginePort,
      user: TDENGINE_USER,
      password: TDENGINE_PASSWORD
    };
  }

  const tunnelTarget = await createSshForwardTunnel({
    sshConfig,
    dstAddr: TDENGINE_HOST,
    dstPort: tdenginePort
  });

  console.error(`✅ MCP TDengine Server 已啟動（經 SSH 通道，jump hops: ${sshConfig.jumps.length}）`);
  return {
    host: tunnelTarget.host,
    port: tunnelTarget.port,
    user: TDENGINE_USER,
    password: TDENGINE_PASSWORD
  };
}

const TDENGINE_CONFIG = await buildTdengineConfig();
const sqlValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sqlRecordSchema = z.record(z.string(), sqlValueSchema);

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
  query: parseBooleanFlag(TDENGINE_QUERY_OPERATION, true),
  insert: parseBooleanFlag(TDENGINE_INSERT_OPERATION, true),
  update: parseBooleanFlag(TDENGINE_UPDATE_OPERATION, true),
  delete: parseBooleanFlag(TDENGINE_DELETE_OPERATION, true)
};

function assertOperationAllowed(operationName, allowed) {
  if (!allowed) {
    throw new Error(`Operation not allowed: ${operationName}`);
  }
}

function toSafeIdentifier(identifier) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `\`${identifier}\``;
}

function toSqlLiteral(value) {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Invalid number literal: ${value}`);
    }
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  const escaped = String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  return `'${escaped}'`;
}

function buildWhereClause(where) {
  const entries = Object.entries(where);
  if (entries.length === 0) {
    throw new Error("WHERE 條件不可為空");
  }

  const clauses = entries.map(([column, value]) => {
    const safeColumn = toSafeIdentifier(column);
    if (value === null) {
      return `${safeColumn} IS NULL`;
    }
    return `${safeColumn} = ${toSqlLiteral(value)}`;
  });

  return clauses.join(" AND ");
}

// TDengine REST API query function.
async function queryTDengine(sql) {
  const url = `http://${TDENGINE_CONFIG.host}:${TDENGINE_CONFIG.port}/rest/sql`;
  const auth = Buffer.from(`${TDENGINE_CONFIG.user}:${TDENGINE_CONFIG.password}`).toString('base64');
  
  // Ensure sql is a string and handle potential object input.
  let sqlString;
  if (typeof sql === 'string') {
    sqlString = sql;
  } else if (sql && typeof sql === 'object' && sql.sql) {
    // If input is an object, try extracting the sql property.
    sqlString = sql.sql;
  } else {
    sqlString = String(sql);
  }
  
  // TDengine REST API expects a raw SQL string with text/plain content type.
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'text/plain'
    },
    body: sqlString
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TDengine query failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result = await response.json();
  return result;
}

const server = new McpServer({ name: "tdengine-tools", version: "1.0.0" });

// Tool: SQL query.
server.tool(
  "query_tdengine",
  { sql: z.string() },
  async (params) => {
    try {
      assertOperationAllowed("query_tdengine", operationAccess.query);
      // Debug: log the received params.
      console.error('Received params:', JSON.stringify(params));
      console.error('Params type:', typeof params);
      
      // Extract the sql argument.
      const sql = params?.sql || params;
      console.error('Extracted sql:', sql);
      console.error('SQL type:', typeof sql);
      
      const result = await queryTDengine(sql);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "insert_tdengine",
  {
    table: z.string(),
    data: sqlRecordSchema
  },
  async ({ table, data }) => {
    try {
      assertOperationAllowed("insert_tdengine", operationAccess.insert);
      const entries = Object.entries(data);
      if (entries.length === 0) {
        throw new Error("data 不可為空");
      }

      const safeTable = toSafeIdentifier(table);
      const columns = entries.map(([column]) => toSafeIdentifier(column)).join(", ");
      const values = entries.map(([, value]) => toSqlLiteral(value)).join(", ");
      const sql = `INSERT INTO ${safeTable} (${columns}) VALUES (${values})`;
      const result = await queryTDengine(sql);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "update_tdengine",
  {
    table: z.string(),
    data: sqlRecordSchema,
    where: sqlRecordSchema
  },
  async ({ table, data, where }) => {
    try {
      assertOperationAllowed("update_tdengine", operationAccess.update);
      const entries = Object.entries(data);
      if (entries.length === 0) {
        throw new Error("data 不可為空");
      }

      const safeTable = toSafeIdentifier(table);
      const setClause = entries
        .map(([column, value]) => `${toSafeIdentifier(column)} = ${toSqlLiteral(value)}`)
        .join(", ");
      const whereClause = buildWhereClause(where);
      const sql = `UPDATE ${safeTable} SET ${setClause} WHERE ${whereClause}`;
      const result = await queryTDengine(sql);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "delete_tdengine",
  {
    table: z.string(),
    where: sqlRecordSchema
  },
  async ({ table, where }) => {
    try {
      assertOperationAllowed("delete_tdengine", operationAccess.delete);
      const safeTable = toSafeIdentifier(table);
      const whereClause = buildWhereClause(where);
      const sql = `DELETE FROM ${safeTable} WHERE ${whereClause}`;
      const result = await queryTDengine(sql);

      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

