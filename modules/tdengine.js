import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { assertOperationAllowed, closeTunnel, errorResult, jsonResult, lazy, parseBooleanFlag } from "../lib/common.js";
import { requireEntries, sqlRecordSchema, toSafeIdentifier } from "../lib/sql.js";

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
  return requireEntries(where, "where")
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
    TDENGINE_TIMEOUT_MS = "120000",
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

  const timeoutMs = parseInt(TDENGINE_TIMEOUT_MS, 10);
  const headers = {
    Authorization: `Basic ${Buffer.from(`${TDENGINE_USER}:${TDENGINE_PASSWORD}`).toString("base64")}`,
    // TDengine REST API expects a raw SQL string with text/plain content type.
    "Content-Type": "text/plain"
  };

  // REST endpoint (through an SSH tunnel when configured), resolved on first use.
  const getEndpoint = lazy(async () => {
    const tdenginePort = parseInt(TDENGINE_PORT, 10);
    const sshConfig = getSshConfigFromEnv(env, "TDENGINE");
    let target = { host: TDENGINE_HOST, port: tdenginePort };

    if (useSshTunnel(sshConfig)) {
      target = await createSshForwardTunnel({ sshConfig, dstAddr: TDENGINE_HOST, dstPort: tdenginePort });
      console.error(`✅ TDengine 已就緒（經 SSH 通道，jump hops: ${sshConfig.jumps.length}）`);
    } else {
      console.error(`✅ TDengine 已就緒（直連 ${TDENGINE_HOST}:${tdenginePort}）`);
    }
    return { ...target, url: `http://${target.host}:${target.port}/rest/sql` };
  });

  async function queryTDengine(sql) {
    const { url } = await getEndpoint();
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: sql,
      signal: AbortSignal.timeout(timeoutMs)
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
      return jsonResult(await fn(params));
    } catch (error) {
      return errorResult(`Error: ${error.message}`);
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
        handle(async ({ sql }) => {
          assertOperationAllowed("query_tdengine", operationAccess.query);
          return queryTDengine(sql);
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
          const entries = requireEntries(data, "data");
          const columns = entries.map(([column]) => toSafeIdentifier(column)).join(", ");
          const values = entries.map(([, value]) => toSqlLiteral(value)).join(", ");
          return queryTDengine(`INSERT INTO ${toSafeIdentifier(table)} (${columns}) VALUES (${values})`);
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
          const setClause = requireEntries(data, "data")
            .map(([column, value]) => `${toSafeIdentifier(column)} = ${toSqlLiteral(value)}`)
            .join(", ");
          return queryTDengine(`UPDATE ${toSafeIdentifier(table)} SET ${setClause} WHERE ${buildWhereClause(where)}`);
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
          return queryTDengine(`DELETE FROM ${toSafeIdentifier(table)} WHERE ${buildWhereClause(where)}`);
        })
      );
    }
  };
}
