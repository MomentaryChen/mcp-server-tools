import test from "node:test";
import assert from "node:assert/strict";
import { BSON } from "mongodb";
import { collectWithinLimit, fromEjson } from "../modules/mongodb.js";

test("fromEjson: plain JSON passes through", () => {
  assert.deepEqual(fromEjson({ a: 1, b: { $gt: 2 }, c: ["x"] }), { a: 1, b: { $gt: 2 }, c: ["x"] });
  assert.equal(fromEjson(undefined), undefined);
  assert.equal(fromEjson(null), null);
});

test("fromEjson: $oid and $date become BSON types", () => {
  const out = fromEjson({ _id: { $oid: "65f000000000000000000001" }, t: { $gte: { $date: "2026-01-01T00:00:00Z" } } });
  assert.ok(out._id instanceof BSON.ObjectId);
  assert.ok(out.t.$gte instanceof Date);
});

test("fromEjson: $regex with sibling operators keeps the siblings", () => {
  const out = fromEjson({ n: { $regex: "a", $options: "i", $nin: ["x"] } });
  assert.deepEqual(Object.keys(out.n).sort(), ["$nin", "$regex"]);
  assert.deepEqual(out.n.$nin, ["x"]);
  assert.ok(out.n.$regex instanceof BSON.BSONRegExp);
  assert.equal(out.n.$regex.pattern, "a");
  assert.equal(out.n.$regex.options, "i");
});

test("fromEjson: $regex with siblings nested in $and / arrays, no $options", () => {
  const out = fromEjson({ $and: [{ s: { $regex: "^ab", $ne: "abc" } }, { d: { $date: "2026-01-01T00:00:00Z" } }] });
  assert.equal(out.$and[0].s.$regex.pattern, "^ab");
  assert.equal(out.$and[0].s.$regex.options, "");
  assert.equal(out.$and[0].s.$ne, "abc");
  assert.ok(out.$and[1].d instanceof Date);
});

test("fromEjson: lone $regex / $options is unchanged (regex literal)", () => {
  const out = fromEjson({ n: { $regex: "a", $options: "i" } });
  assert.ok(out.n instanceof BSON.BSONRegExp);
  assert.equal(out.n.options, "i");
});

test("fromEjson: no placeholder keys leak into the result", () => {
  const json = JSON.stringify(Object.keys(fromEjson({ n: { $regex: "a", $options: "i", $exists: true } }).n));
  assert.ok(!json.includes("mcp_"));
});

test("collectWithinLimit: returns a plain array when everything fits", async () => {
  const docs = [{ a: 1 }, { a: 2 }];
  assert.deepEqual(await collectWithinLimit(docs, 1000), docs);
  assert.deepEqual(await collectWithinLimit([], 10), []);
});

test("collectWithinLimit: stops at the size limit and stops reading the source", async () => {
  let pulled = 0;
  async function* source() {
    for (let i = 0; i < 100; i++) {
      pulled++;
      yield { i, pad: "x".repeat(20) };
    }
  }
  const one = JSON.stringify({ i: 0, pad: "x".repeat(20) }).length; // 29
  const result = await collectWithinLimit(source(), 2 + one * 3 + 2); // room for exactly 3 docs + 2 commas
  assert.equal(result.truncated, true);
  assert.equal(result.returnedCount, 3);
  assert.deepEqual(result.documents.map((d) => d.i), [0, 1, 2]);
  assert.ok(JSON.stringify(result.documents).length <= 2 + one * 3 + 2);
  assert.equal(pulled, 4);
});

test("collectWithinLimit: a single oversized document yields an empty truncated result", async () => {
  const result = await collectWithinLimit([{ big: "y".repeat(500) }], 100);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.documents, []);
});
