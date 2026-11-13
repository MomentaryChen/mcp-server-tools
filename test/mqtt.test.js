import test from "node:test";
import assert from "node:assert/strict";
import { compileTopicFilter } from "../modules/mqtt.js";

const matches = (filter, topic) => compileTopicFilter(filter)(topic);

test("compileTopicFilter: exact topic", () => {
  assert.equal(matches("a/b/c", "a/b/c"), true);
  assert.equal(matches("a/b/c", "a/b"), false);
  assert.equal(matches("a/b/c", "a/b/c/d"), false);
  assert.equal(matches("a/b/c", "xa/b/c"), false);
});

test("compileTopicFilter: + matches exactly one level", () => {
  assert.equal(matches("a/+/c", "a/b/c"), true);
  assert.equal(matches("a/+/c", "a//c"), true);
  assert.equal(matches("a/+/c", "a/b/x/c"), false);
  assert.equal(matches("a/+", "a/b"), true);
  assert.equal(matches("a/+", "a/b/c"), false);
  assert.equal(matches("+/+", "x/y"), true);
});

test("compileTopicFilter: trailing # matches the parent level and everything below", () => {
  assert.equal(matches("a/#", "a"), true);
  assert.equal(matches("a/#", "a/b"), true);
  assert.equal(matches("a/#", "a/b/c"), true);
  assert.equal(matches("a/#", "ab"), false);
  assert.equal(matches("a/#", "b/a"), false);
  assert.equal(matches("a/+/#", "a/b/c/d"), true);
});

test("compileTopicFilter: root # matches every topic", () => {
  for (const topic of ["a", "a/b/c", "/leading", ""]) {
    assert.equal(matches("#", topic), true, topic);
  }
});

test("compileTopicFilter: regex metacharacters in levels are literal", () => {
  assert.equal(matches("dev.1/temp", "dev.1/temp"), true);
  assert.equal(matches("dev.1/temp", "devX1/temp"), false);
  assert.equal(matches("a(b)|c/[x]", "a(b)|c/[x]"), true);
  assert.equal(matches("a(b)|c/[x]", "c/[x]"), false);
  assert.equal(matches("cost$/^up*", "cost$/^up*"), true);
  assert.equal(matches("cost$/^up*", "cost/up"), false);
  assert.equal(matches("a\\b?", "a\\b?"), true);
  assert.equal(matches("a\\b?", "a\\"), false);
});
