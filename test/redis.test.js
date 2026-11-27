import test from "node:test";
import assert from "node:assert/strict";
import { classifyCommand, fitEntries, parseCommandInfo } from "../modules/redis.js";

// Shapes of Redis 7 COMMAND INFO replies (as ioredis returns them).
const GET = ["get", 2, ["readonly", "fast"], 1, 1, 1, ["@read", "@string", "@fast"], [], [], []];
const SET = ["set", -3, ["write", "denyoom"], 1, 1, 1, ["@write", "@string", "@slow"], [], [], []];
const PING = ["ping", -1, ["fast"], 0, 0, 0, ["@fast", "@connection"], [], [], []];
const BLPOP = ["blpop", -3, ["write", "blocking"], 1, -2, 1, ["@write", "@list", "@slow", "@blocking"], [], [], []];
const OBJECT = [
  "object", -2, [], 0, 0, 0, ["@slow"], [], [],
  [["object|encoding", 3, ["readonly"], 2, 2, 1, ["@keyspace", "@read", "@slow"], [], [], []]]
];

test("parseCommandInfo: lower-cases flags and categories and indexes subcommands", () => {
  const info = parseCommandInfo(OBJECT);
  assert.equal(info.name, "object");
  assert.deepEqual(info.categories, ["@slow"]);
  assert.deepEqual(info.subcommands.get("object|encoding").flags, ["readonly"]);
  assert.equal(parseCommandInfo(null), null);
});

test("classifyCommand: read and write commands", () => {
  assert.equal(classifyCommand("get", parseCommandInfo(GET)), "read");
  assert.equal(classifyCommand("set", parseCommandInfo(SET)), "write");
  assert.equal(classifyCommand("ping", parseCommandInfo(PING)), "read");
  assert.equal(classifyCommand("object|encoding", parseCommandInfo(OBJECT).subcommands.get("object|encoding")), "read");
});

test("classifyCommand: blocks by category, by name, and unknown commands", () => {
  assert.match(classifyCommand("blpop", parseCommandInfo(BLPOP)).blocked, /@blocking/);
  // Blocked by name even if the server reported harmless categories.
  for (const name of ["keys", "FLUSHALL", "select", "config|get", "eval", "multi", "client|list"]) {
    assert.ok(classifyCommand(name, parseCommandInfo(GET)).blocked, name);
  }
  assert.match(classifyCommand("nope", null).blocked, /未知的指令/);
});

test("fitEntries: keeps the leading entries that fit", () => {
  const entries = ["aaaa", "bbbb", "cccc"]; // each '"xxxx"' = 6 chars
  assert.deepEqual(fitEntries(entries, 100), { entries, truncated: false });
  // [] (2) + 6 + 1 + 6 = 15 fits two entries, a third needs 22.
  assert.deepEqual(fitEntries(entries, 15), { entries: ["aaaa", "bbbb"], truncated: true });
  assert.deepEqual(fitEntries(entries, 3), { entries: [], truncated: true });
});
