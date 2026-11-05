import { z } from "zod";
import mysql from "mysql2/promise";
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

function asJson(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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
          return asJson(rows);
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
          const [result] = await (await db()).execute(sql, values);

          return asJson({
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
          const [result] = await (await db()).execute(sql, [...setParams, ...whereParams]);

          return asJson({
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

          return asJson({
            message: "delete success",
            affectedRows: result.affectedRows
          });
        }
      );
    }
  };
}
