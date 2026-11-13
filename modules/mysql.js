import { z } from "zod";
import mysql from "mysql2/promise";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { closeTunnel, jsonResult, lazy, parseBooleanFlag } from "../lib/common.js";
import { requireEntries, sqlRecordSchema, toSafeIdentifier } from "../lib/sql.js";

const READ_ONLY_PREFIX = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;
const MAX_BATCH_INSERT = 1000;

export function buildWhereClause(where) {
  const clauses = [];
  const params = [];

  for (const [column, value] of requireEntries(where, "where")) {
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

export function assertReadOnlyQuery(sql) {
  const trimmedSql = String(sql || "").trim();
  if (!trimmedSql) {
    throw new Error("SQL 不可為空");
  }

  // Allow only read-only SQL to prevent bypassing write-operation controls via query_mysql.
  if (!READ_ONLY_PREFIX.test(trimmedSql)) {
    throw new Error("Operation not allowed: query_mysql only allows read-only SQL");
  }
}

// Run a query on a pooled connection and stop reading once maxRows + 1 rows have arrived,
// instead of buffering the whole result set like pool.query() does. Resolves to
// { fields, rows, truncated } for a result set, or { okPacket } for a non-result-set reply.
// mysql2 cannot cancel a running query, so a truncated read destroys the connection (the
// pool replaces it); otherwise the connection is released back to the pool.
function queryLimited(corePool, sql, maxRows) {
  return new Promise((resolve, reject) => {
    corePool.getConnection((connErr, conn) => {
      if (connErr) {
        reject(connErr);
        return;
      }

      let settled = false;
      let fields;
      let okPacket;
      const rows = [];

      const onConnError = (err) => finish(reject, err, true);
      const finish = (settle, value, destroy = false) => {
        if (settled) return;
        settled = true;
        conn.removeListener("error", onConnError);
        if (destroy) {
          conn.destroy();
          conn.stream?.destroy(); // Hard-close the socket so the server stops sending rows.
        } else {
          conn.release();
        }
        settle(value);
      };

      // A fatal connection error is reported on the connection, not on a callback-less query.
      conn.once("error", onConnError);

      let query;
      try {
        query = conn.query({ sql, rowsAsArray: true });
      } catch (err) {
        finish(reject, err);
        return;
      }

      query.on("fields", (f) => {
        fields = f;
      });
      query.on("result", (row) => {
        if (settled) return;
        if (!fields) {
          okPacket = row; // Not a result set (e.g. OK packet).
          return;
        }
        rows.push(row);
        if (rows.length > maxRows) {
          finish(resolve, { fields, rows: rows.slice(0, maxRows), truncated: true }, true);
        }
      });
      query.on("error", (err) => finish(reject, err));
      query.on("end", () =>
        finish(resolve, fields ? { fields, rows, truncated: false } : { okPacket })
      );
    });
  });
}

export default function create({ env }) {
  const {
    MYSQL_HOST = "127.0.0.1",
    MYSQL_PORT = "3306",
    MYSQL_USER,
    MYSQL_PASSWORD,
    MYSQL_DATABASE,
    MYSQL_MAX_ROWS = "500",
    MYSQL_QUERY_OPERATION = "true",
    MYSQL_INSERT_OPERATION = "true",
    MYSQL_UPDATE_OPERATION = "true",
    MYSQL_DELETE_OPERATION = "true"
  } = env;

  const operationAccess = {
    query: parseBooleanFlag(MYSQL_QUERY_OPERATION, true),
    insert: parseBooleanFlag(MYSQL_INSERT_OPERATION, true),
    update: parseBooleanFlag(MYSQL_UPDATE_OPERATION, true),
    delete: parseBooleanFlag(MYSQL_DELETE_OPERATION, true)
  };

  const defaultMaxRows = parseInt(MYSQL_MAX_ROWS, 10);

  // Drop a pool whose SSH tunnel died; the next tool call builds a new tunnel and pool.
  function discard(ctx) {
    getDb.reset();
    ctx.pool?.end().catch(() => {});
    closeTunnel(ctx.target);
  }

  // Connection pool (and SSH tunnel) are created on first use and shared by all sessions.
  const getDb = lazy(async () => {
    if (!MYSQL_USER || !MYSQL_DATABASE) {
      throw new Error("請在 .env 或環境變數中設定 MYSQL_USER、MYSQL_DATABASE（MYSQL_PASSWORD 可為空）");
    }

    const mysqlPort = parseInt(MYSQL_PORT, 10);
    const sshConfig = getSshConfigFromEnv(env, "MYSQL");
    const ctx = { target: { host: MYSQL_HOST, port: mysqlPort } };

    if (useSshTunnel(sshConfig)) {
      ctx.target = await createSshForwardTunnel({
        sshConfig,
        dstAddr: MYSQL_HOST,
        dstPort: mysqlPort,
        onClose: () => discard(ctx)
      });
      console.error(`✅ MySQL 已就緒（經 SSH 通道，jump hops: ${sshConfig.jumps.length}）`);
    } else {
      console.error(`✅ MySQL 已就緒（直連 ${MYSQL_HOST}:${mysqlPort}）`);
    }

    ctx.pool = mysql.createPool({
      host: ctx.target.host,
      port: ctx.target.port,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE,
      connectionLimit: 5,
      // TCP keepalive, and drop idle connections before a server / NAT timeout kills them,
      // so a query after a quiet period doesn't land on a dead socket.
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      maxIdle: 2,
      idleTimeout: 60000
    });
    return ctx;
  });

  const db = async () => (await getDb()).pool;

  // Batch insert as one multi-row INSERT, so the batch is all-or-nothing. Every row must have
  // the same columns as the first. Uses query() with "VALUES ?" (client-side escaping) instead
  // of execute(), which caps a prepared statement at 65535 placeholders.
  async function insertRows(table, rows) {
    const columns = requireEntries(rows[0], "data[0]").map(([column]) => column);
    const columnKey = [...columns].sort().join(",");
    const values = rows.map((row, i) => {
      if (Object.keys(row).sort().join(",") !== columnKey) {
        throw new Error(`data[${i}] 的欄位與 data[0] 不同，batch insert 每筆欄位必須相同（${columns.join(", ")}）`);
      }
      return columns.map((column) => row[column]);
    });

    const sql = `INSERT INTO ${toSafeIdentifier(table)} (${columns.map(toSafeIdentifier).join(", ")}) VALUES ?`;
    const [result] = await (await db()).query(sql, [values]);

    return {
      message: "batch insert success",
      affectedRows: result.affectedRows,
      // For a multi-row INSERT MySQL reports the AUTO_INCREMENT id of the first row.
      firstInsertId: result.insertId
    };
  }

  return {
    info: { name: "mysql-tools", version: "2.0.0" },
    warmup: getDb,

    async close() {
      const ctx = getDb.current();
      if (ctx) {
        await ctx.pool.end().catch(() => {});
        closeTunnel(ctx.target);
      }
    },

    register(server) {
      // Tools turned off with MYSQL_*_OPERATION=false are not registered at all, so they
      // cost no context and the model never tries them.
      if (operationAccess.query) {
        server.tool(
          "query_mysql",
          "Run a read-only SQL statement (SELECT / SHOW / DESCRIBE / EXPLAIN). Returns { columns, rows, rowCount, truncated }: each row is an array in column order. Reading stops after maxRows rows; rowCount is the number of rows returned and truncated: true means more rows exist.",
          {
            sql: z.string(),
            maxRows: z.number().int().positive().optional().describe(`Rows to return (default ${defaultMaxRows}); use LIMIT in the SQL to avoid fetching more`)
          },
          async ({ sql, maxRows = defaultMaxRows }) => {
            assertReadOnlyQuery(sql);
            // Arrays + one column list instead of one object per row: column names are
            // not repeated on every row (roughly half the size for wide results).
            // Streams rows and stops after maxRows + 1, so a huge result is never buffered.
            const result = await queryLimited((await db()).pool, sql, maxRows);
            if (!result.fields) {
              return jsonResult(result.okPacket); // Not a result set (e.g. EXPLAIN variants returning OK packets).
            }
            return jsonResult({
              columns: result.fields.map((f) => f.name),
              rows: result.rows,
              rowCount: result.rows.length,
              truncated: result.truncated
            });
          }
        );
      }

      if (operationAccess.insert) {
        server.tool(
          "insert_mysql",
          `Insert one row (data: object) or a batch of up to ${MAX_BATCH_INSERT} rows (data: array of objects with the same columns) in one INSERT statement.`,
          {
            table: z.string(),
            data: z.union([sqlRecordSchema, z.array(sqlRecordSchema).min(1).max(MAX_BATCH_INSERT)])
          },
          async ({ table, data }) => {
            if (Array.isArray(data)) {
              return jsonResult(await insertRows(table, data));
            }

            const entries = requireEntries(data, "data");
            const columns = entries.map(([column]) => toSafeIdentifier(column)).join(", ");
            const placeholders = entries.map(() => "?").join(", ");

            const sql = `INSERT INTO ${toSafeIdentifier(table)} (${columns}) VALUES (${placeholders})`;
            const [result] = await (await db()).execute(sql, entries.map(([, value]) => value));

            return jsonResult({
              message: "insert success",
              affectedRows: result.affectedRows,
              insertId: result.insertId
            });
          }
        );
      }

      if (operationAccess.update) {
        server.tool(
          "update_mysql",
          "Run UPDATE table SET data WHERE where (all where columns ANDed with =, null means IS NULL; where must be non-empty). Returns affectedRows and changedRows.",
          {
            table: z.string(),
            data: sqlRecordSchema,
            where: sqlRecordSchema
          },
          async ({ table, data, where }) => {
            const dataEntries = requireEntries(data, "data");
            // A null placeholder value is sent as SQL NULL, so SET needs no special case.
            const setClause = dataEntries.map(([column]) => `${toSafeIdentifier(column)} = ?`).join(", ");
            const { clause: whereClause, params: whereParams } = buildWhereClause(where);

            const sql = `UPDATE ${toSafeIdentifier(table)} SET ${setClause} WHERE ${whereClause}`;
            const [result] = await (await db()).execute(sql, [...dataEntries.map(([, value]) => value), ...whereParams]);

            return jsonResult({
              message: "update success",
              affectedRows: result.affectedRows,
              changedRows: result.changedRows
            });
          }
        );
      }

      if (operationAccess.delete) {
        server.tool(
          "delete_mysql",
          "Run DELETE FROM table WHERE where LIMIT limit (where columns ANDed with =, null means IS NULL; where must be non-empty; limit defaults to 1 row).",
          {
            table: z.string(),
            where: sqlRecordSchema,
            limit: z.number().int().positive().optional()
          },
          async ({ table, where, limit }) => {
            const safeTable = toSafeIdentifier(table);
            const { clause: whereClause, params } = buildWhereClause(where);
            const safeLimit = limit ?? 1;
            const sql = `DELETE FROM ${safeTable} WHERE ${whereClause} LIMIT ${safeLimit}`;
            const [result] = await (await db()).execute(sql, params);

            return jsonResult({
              message: "delete success",
              affectedRows: result.affectedRows
            });
          }
        );
      }
    }
  };
}
