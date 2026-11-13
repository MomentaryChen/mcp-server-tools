import test from "node:test";
import assert from "node:assert/strict";
import { requireEntries, toSafeIdentifier } from "../lib/sql.js";
import {
  assertReadOnlyQuery as tdAssertReadOnlyQuery,
  buildWhereClause as tdBuildWhereClause,
  toSqlLiteral
} from "../modules/tdengine.js";
import {
  assertReadOnlyQuery,
  buildWhereClause as mysqlBuildWhereClause
} from "../modules/mysql.js";

test("toSafeIdentifier: backtick-quotes valid identifiers", () => {
  assert.equal(toSafeIdentifier("users"), "`users`");
  assert.equal(toSafeIdentifier("_col_1"), "`_col_1`");
});

test("toSafeIdentifier: rejects anything that is not a plain identifier", () => {
  for (const bad of ["", "1abc", "a b", "a-b", "a.b", "a`b", "x; DROP TABLE t", "名字"]) {
    assert.throws(() => toSafeIdentifier(bad), /Invalid SQL identifier/, bad);
  }
});

test("requireEntries: returns entries in order", () => {
  assert.deepEqual(requireEntries({ a: 1, b: null }, "data"), [["a", 1], ["b", null]]);
});

test("requireEntries: rejects an empty record with a label-specific message", () => {
  assert.throws(() => requireEntries({}, "where"), { message: "WHERE 條件不可為空" });
  assert.throws(() => requireEntries({}, "data"), { message: "data 不可為空" });
});

test("tdengine toSqlLiteral: scalars", () => {
  assert.equal(toSqlLiteral(null), "NULL");
  assert.equal(toSqlLiteral(42), "42");
  assert.equal(toSqlLiteral(-1.5), "-1.5");
  assert.equal(toSqlLiteral(true), "TRUE");
  assert.equal(toSqlLiteral(false), "FALSE");
  assert.equal(toSqlLiteral("abc"), "'abc'");
});

test("tdengine toSqlLiteral: escapes quotes and backslashes", () => {
  assert.equal(toSqlLiteral("it's"), "'it\\'s'");
  assert.equal(toSqlLiteral("a\\b"), "'a\\\\b'");
  // A trailing backslash must not escape the closing quote.
  assert.equal(toSqlLiteral("x\\' OR 1=1 --"), "'x\\\\\\' OR 1=1 --'");
});

test("tdengine toSqlLiteral: rejects non-finite numbers", () => {
  assert.throws(() => toSqlLiteral(NaN), /Invalid number literal/);
  assert.throws(() => toSqlLiteral(Infinity), /Invalid number literal/);
});

test("tdengine buildWhereClause: inlines literals and handles NULL", () => {
  assert.equal(
    tdBuildWhereClause({ ts: "2024-01-01", id: 7, gone: null }),
    "`ts` = '2024-01-01' AND `id` = 7 AND `gone` IS NULL"
  );
});

test("tdengine buildWhereClause: rejects empty where and bad columns", () => {
  assert.throws(() => tdBuildWhereClause({}), { message: "WHERE 條件不可為空" });
  assert.throws(() => tdBuildWhereClause({ "a or 1=1": 1 }), /Invalid SQL identifier/);
});

test("mysql buildWhereClause: uses placeholders and skips params for NULL", () => {
  assert.deepEqual(mysqlBuildWhereClause({ id: 7, name: "o'neil", deleted_at: null }), {
    clause: "`id` = ? AND `name` = ? AND `deleted_at` IS NULL",
    params: [7, "o'neil"]
  });
});

test("mysql buildWhereClause: rejects empty where and bad columns", () => {
  assert.throws(() => mysqlBuildWhereClause({}), { message: "WHERE 條件不可為空" });
  assert.throws(() => mysqlBuildWhereClause({ "id`": 1 }), /Invalid SQL identifier/);
});

test("mysql assertReadOnlyQuery: allows read-only statements", () => {
  for (const sql of [
    "SELECT 1",
    "  select * from t",
    "SHOW TABLES",
    "describe users",
    "DESC users",
    "EXPLAIN SELECT 1"
  ]) {
    assert.doesNotThrow(() => assertReadOnlyQuery(sql), sql);
  }
});

test("mysql assertReadOnlyQuery: rejects writes, empty SQL and prefix look-alikes", () => {
  assert.throws(() => assertReadOnlyQuery(""), { message: "SQL 不可為空" });
  assert.throws(() => assertReadOnlyQuery(undefined), { message: "SQL 不可為空" });
  for (const sql of ["UPDATE t SET a=1", "DELETE FROM t", "INSERT INTO t VALUES (1)", "DROP TABLE t", "SELECTED", "SHOWX"]) {
    assert.throws(() => assertReadOnlyQuery(sql), /only allows read-only SQL/, sql);
  }
});

test("tdengine assertReadOnlyQuery: allows single read-only statements", () => {
  for (const sql of ["SELECT 1", "  show databases", "DESCRIBE t", "SELECT 1;", "SELECT * FROM t WHERE s = 'a;b'"]) {
    assert.doesNotThrow(() => tdAssertReadOnlyQuery(sql), sql);
  }
});

test("tdengine assertReadOnlyQuery: rejects writes, empty and multi-statement SQL", () => {
  for (const sql of ["", "DROP DATABASE db", "INSERT INTO t VALUES (now, 1)", "SELECT 1; DROP TABLE t", "SELECTX 1"]) {
    assert.throws(() => tdAssertReadOnlyQuery(sql), sql);
  }
});
