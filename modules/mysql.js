import { z } from "zod";
import mysql from "mysql2/promise";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { assertOperationAllowed, closeTunnel, jsonResult, lazy, parseBooleanFlag } from "../lib/common.js";
import { requireEntries, sqlRecordSchema, toSafeIdentifier } from "../lib/sql.js";

const READ_ONLY_PREFIX = /^(SELECT|SHOW|DESCRIBE|DESC|EXPLAIN)\b/i;

function buildWhereClause(where) {
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

function assertReadOnlyQuery(sql) {
  const trimmedSql = String(sql || "").trim();
  if (!trimmedSql) {
    throw new Error("SQL 不可為空");
  }

  // Allow only read-only SQL to prevent bypassing write-operation controls via query_mysql.
  if (!READ_ONLY_PREFIX.test(trimmedSql)) {
    throw new Error("Operation not allowed: query_mysql only allows read-only SQL");
  }
}

export default function create({ env }) {
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
  } = env;

  const operationAccess = {
    query: parseBooleanFlag(MYSQL_QUERY_OPERATION, true),
    insert: parseBooleanFlag(MYSQL_INSERT_OPERATION, true),
    update: parseBooleanFlag(MYSQL_UPDATE_OPERATION, true),
    delete: parseBooleanFlag(MYSQL_DELETE_OPERATION, true)
  };

  // Connection pool (and SSH tunnel) are created on first use and shared by all sessions.
  const getDb = lazy(async () => {
    if (!MYSQL_USER || !MYSQL_DATABASE) {
      throw new Error("請在 .env 或環境變數中設定 MYSQL_USER、MYSQL_DATABASE（MYSQL_PASSWORD 可為空）");
    }

    const mysqlPort = parseInt(MYSQL_PORT, 10);
    const sshConfig = getSshConfigFromEnv(env, "MYSQL");
    let target = { host: MYSQL_HOST, port: mysqlPort };

    if (useSshTunnel(sshConfig)) {
      target = await createSshForwardTunnel({ sshConfig, dstAddr: MYSQL_HOST, dstPort: mysqlPort });
      console.error(`✅ MySQL 已就緒（經 SSH 通道，jump hops: ${sshConfig.jumps.length}）`);
    } else {
      console.error(`✅ MySQL 已就緒（直連 ${MYSQL_HOST}:${mysqlPort}）`);
    }

    const pool = mysql.createPool({
      host: target.host,
      port: target.port,
      user: MYSQL_USER,
      password: MYSQL_PASSWORD,
      database: MYSQL_DATABASE
    });
    return { pool, target };
  });

  const db = async () => (await getDb()).pool;

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
      server.tool(
        "query_mysql",
        { sql: z.string() },
        async ({ sql }) => {
          assertOperationAllowed("query_mysql", operationAccess.query);
          assertReadOnlyQuery(sql);
          const [rows] = await (await db()).query(sql);
          return jsonResult(rows);
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

      server.tool(
        "update_mysql",
        {
          table: z.string(),
          data: sqlRecordSchema,
          where: sqlRecordSchema
        },
        async ({ table, data, where }) => {
          assertOperationAllowed("update_mysql", operationAccess.update);
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
          const [result] = await (await db()).execute(sql, params);

          return jsonResult({
            message: "delete success",
            affectedRows: result.affectedRows
          });
        }
      );
    }
  };
}
