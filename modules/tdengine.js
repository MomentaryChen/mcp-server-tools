import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { closeTunnel, errorResult, jsonResult, lazy, parseBooleanFlag, positiveInt } from "../lib/common.js";
import { requireEntries, sqlRecordSchema, toSafeIdentifier } from "../lib/sql.js";

export function toSqlLiteral(value) {
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

const READ_ONLY_PREFIX = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

export function assertReadOnlyQuery(sql) {
  const trimmedSql = String(sql || "").trim();
  if (!trimmedSql) {
    throw new Error("SQL 不可為空");
  }

  // Allow only read-only SQL to prevent bypassing write-operation controls via query_tdengine.
  if (!READ_ONLY_PREFIX.test(trimmedSql)) {
    throw new Error("Operation not allowed: query_tdengine only allows read-only SQL");
  }

  // Refuse multiple statements: a ";" outside string literals is only allowed at the very end.
  const withoutLiterals = trimmedSql.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`/g, "");
  if (/;\s*\S/.test(withoutLiterals)) {
    throw new Error("Operation not allowed: query_tdengine 只能執行單一 SQL 語句");
  }
}

// Compact a TDengine REST result ({ code, column_meta, data, rows }) to the query_mysql shape:
// one column-name list plus row arrays, capped at maxRows. rowCount is the full row count.
// Anything without a data array is returned unchanged.
export function compactQueryResult(result, maxRows) {
  if (!result || !Array.isArray(result.data)) {
    return result;
  }
  const columns = Array.isArray(result.column_meta)
    ? result.column_meta.map((meta) => (Array.isArray(meta) ? meta[0] : meta?.name))
    : result.head;
  const rowCount = typeof result.rows === "number" ? result.rows : result.data.length;
  return {
    columns,
    rows: result.data.slice(0, maxRows),
    rowCount,
    truncated: result.data.length > maxRows
  };
}

export function buildWhereClause(where) {
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
    TDENGINE_MAX_ROWS = "500",
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
  const defaultMaxRows = positiveInt(TDENGINE_MAX_ROWS, 500);
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
      target = await createSshForwardTunnel({
        sshConfig,
        dstAddr: TDENGINE_HOST,
        dstPort: tdenginePort,
        // Tunnel died: forget the endpoint so the next query builds a new tunnel.
        onClose: () => {
          getEndpoint.reset();
          closeTunnel(target);
        }
      });
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
      // Tools turned off with TDENGINE_*_OPERATION=false are not registered at all, so they
      // cost no context and the model never tries them.
      if (operationAccess.query) {
        server.tool(
          "query_tdengine",
          "Run a read-only SQL statement (SELECT / SHOW / DESCRIBE / EXPLAIN, single statement) through the TDengine REST API. Returns { columns, rows, rowCount, truncated }: each row is an array in column order, at most maxRows rows are returned and rowCount is the total row count of the result.",
          {
            sql: z.string(),
            maxRows: z.number().int().positive().optional().describe(`Rows to return (default ${defaultMaxRows}); use LIMIT in the SQL to avoid fetching more`)
          },
          handle(async ({ sql, maxRows = defaultMaxRows }) => {
            assertReadOnlyQuery(sql);
            return compactQueryResult(await queryTDengine(sql), maxRows);
          })
        );
      }

      if (operationAccess.insert) {
        server.tool(
          "insert_tdengine",
          "Insert one row (data: column -> value) into a TDengine table. Returns the raw TDengine REST response.",
          {
            table: z.string(),
            data: sqlRecordSchema
          },
          handle(async ({ table, data }) => {
            const entries = requireEntries(data, "data");
            const columns = entries.map(([column]) => toSafeIdentifier(column)).join(", ");
            const values = entries.map(([, value]) => toSqlLiteral(value)).join(", ");
            return queryTDengine(`INSERT INTO ${toSafeIdentifier(table)} (${columns}) VALUES (${values})`);
          })
        );
      }

      if (operationAccess.update) {
        server.tool(
          "update_tdengine",
          "Run UPDATE table SET data WHERE where (all where columns ANDed with =, null means IS NULL; where must be non-empty). Returns the raw TDengine REST response.",
          {
            table: z.string(),
            data: sqlRecordSchema,
            where: sqlRecordSchema
          },
          handle(async ({ table, data, where }) => {
            const setClause = requireEntries(data, "data")
              .map(([column, value]) => `${toSafeIdentifier(column)} = ${toSqlLiteral(value)}`)
              .join(", ");
            return queryTDengine(`UPDATE ${toSafeIdentifier(table)} SET ${setClause} WHERE ${buildWhereClause(where)}`);
          })
        );
      }

      if (operationAccess.delete) {
        server.tool(
          "delete_tdengine",
          "Delete every row matching where (all columns ANDed with =, null means IS NULL; where must be non-empty) from a TDengine table. Returns the raw TDengine REST response.",
          {
            table: z.string(),
            where: sqlRecordSchema
          },
          handle(async ({ table, where }) => {
            return queryTDengine(`DELETE FROM ${toSafeIdentifier(table)} WHERE ${buildWhereClause(where)}`);
          })
        );
      }
    }
  };
}
