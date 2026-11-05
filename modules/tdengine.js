import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../scripts/ssh-tunnel.js";
import { assertOperationAllowed, closeTunnel, lazy, parseBooleanFlag } from "../lib/common.js";

const sqlValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const sqlRecordSchema = z.record(z.string(), sqlValueSchema);

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

  return entries
    .map(([column, value]) => {
      const safeColumn = toSafeIdentifier(column);
      if (value === null) {
        return `${safeColumn} IS NULL`;
      }
      return `${safeColumn} = ${toSqlLiteral(value)}`;
    })
    .join(" AND ");
}

export default function create({ env }) {
  const {
    TDENGINE_HOST = "127.0.0.1",
    TDENGINE_PORT = "6041",
    TDENGINE_USER = "root",
    TDENGINE_PASSWORD = "taosdata",
    TDENGINE_QUERY_OPERATION = "true",
    TDENGINE_INSERT_OPERATION = "true",
    TDENGINE_UPDATE_OPERATION = "true",
    TDENGINE_DELETE_OPERATION = "true"
  } = env;

  const operationAccess = {
    query: parseBooleanFlag(TDENGINE_QUERY_OPERATION, true),
    insert: parseBooleanFlag(TDENGINE_INSERT_OPERATION, true),
    update: parseBooleanFlag(TDENGINE_UPDATE_OPERATION, true),
    delete: parseBooleanFlag(TDENGINE_DELETE_OPERATION, true)
  };

  // REST endpoint (through an SSH tunnel when configured), resolved on first use.
  const getEndpoint = lazy(async () => {
    const tdenginePort = parseInt(TDENGINE_PORT, 10);
    const sshConfig = getSshConfigFromEnv(env, "TDENGINE");

    if (!useSshTunnel(sshConfig)) {
      console.error(`✅ TDengine 已就緒（直連 ${TDENGINE_HOST}:${tdenginePort}）`);
      return { host: TDENGINE_HOST, port: tdenginePort };
    }

    const target = await createSshForwardTunnel({ sshConfig, dstAddr: TDENGINE_HOST, dstPort: tdenginePort });
    console.error(`✅ TDengine 已就緒（經 SSH 通道，jump hops: ${sshConfig.jumps.length}）`);
    return target;
  });

  // TDengine REST API query function.
  async function queryTDengine(sql) {
    const { host, port } = await getEndpoint();
    const url = `http://${host}:${port}/rest/sql`;
    const auth = Buffer.from(`${TDENGINE_USER}:${TDENGINE_PASSWORD}`).toString("base64");

    let sqlString;
    if (typeof sql === "string") {
      sqlString = sql;
    } else if (sql && typeof sql === "object" && sql.sql) {
      sqlString = sql.sql;
    } else {
      sqlString = String(sql);
    }

    // TDengine REST API expects a raw SQL string with text/plain content type.
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "text/plain"
      },
      body: sqlString
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`TDengine query failed: ${response.status} ${response.statusText}\n${errorText}`);
    }

    return response.json();
  }

  // Wrap a handler: JSON result on success, isError text on failure.
  const handle = (fn) => async (params) => {
    try {
      const result = await fn(params);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  };

  return {
    info: { name: "tdengine-tools", version: "1.0.0" },
    warmup: getEndpoint,

    async close() {
      closeTunnel(getEndpoint.current());
    },

    register(server) {
      server.tool(
        "query_tdengine",
        { sql: z.string() },
        handle(async (params) => {
          assertOperationAllowed("query_tdengine", operationAccess.query);
          return queryTDengine(params?.sql || params);
        })
      );

      server.tool(
        "insert_tdengine",
        {
          table: z.string(),
          data: sqlRecordSchema
        },
        handle(async ({ table, data }) => {
          assertOperationAllowed("insert_tdengine", operationAccess.insert);
          const entries = Object.entries(data);
          if (entries.length === 0) {
            throw new Error("data 不可為空");
          }

          const safeTable = toSafeIdentifier(table);
          const columns = entries.map(([column]) => toSafeIdentifier(column)).join(", ");
          const values = entries.map(([, value]) => toSqlLiteral(value)).join(", ");
          return queryTDengine(`INSERT INTO ${safeTable} (${columns}) VALUES (${values})`);
        })
      );

      server.tool(
        "update_tdengine",
        {
          table: z.string(),
          data: sqlRecordSchema,
          where: sqlRecordSchema
        },
        handle(async ({ table, data, where }) => {
          assertOperationAllowed("update_tdengine", operationAccess.update);
          const entries = Object.entries(data);
          if (entries.length === 0) {
            throw new Error("data 不可為空");
          }

          const safeTable = toSafeIdentifier(table);
          const setClause = entries
            .map(([column, value]) => `${toSafeIdentifier(column)} = ${toSqlLiteral(value)}`)
            .join(", ");
          return queryTDengine(`UPDATE ${safeTable} SET ${setClause} WHERE ${buildWhereClause(where)}`);
        })
      );

      server.tool(
        "delete_tdengine",
        {
          table: z.string(),
          where: sqlRecordSchema
        },
        handle(async ({ table, where }) => {
          assertOperationAllowed("delete_tdengine", operationAccess.delete);
          const safeTable = toSafeIdentifier(table);
          return queryTDengine(`DELETE FROM ${safeTable} WHERE ${buildWhereClause(where)}`);
        })
      );
    }
  };
}
