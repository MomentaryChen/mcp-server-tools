import test from "node:test";
import assert from "node:assert/strict";
import { RingBuffer, closeTunnel, lazy, parseBooleanFlag } from "../lib/common.js";

test("parseBooleanFlag: truthy and falsy spellings", () => {
  for (const v of ["true", "1", "yes", "Y", " ON ", true, 1]) assert.equal(parseBooleanFlag(v, false), true, String(v));
  for (const v of ["false", "0", "no", "N", " Off ", false, 0]) assert.equal(parseBooleanFlag(v, true), false, String(v));
});

test("parseBooleanFlag: empty / unknown falls back to default", () => {
  assert.equal(parseBooleanFlag(undefined), true);
  assert.equal(parseBooleanFlag(null, false), false);
  assert.equal(parseBooleanFlag("  ", false), false);
  assert.equal(parseBooleanFlag("maybe", false), false);
  assert.equal(parseBooleanFlag("maybe", true), true);
});

test("lazy: calls the factory once and caches the value", async () => {
  let calls = 0;
  const get = lazy(async () => ++calls);
  assert.equal(get.current(), undefined);
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(await get(), 1);
  assert.equal(calls, 1);
  assert.equal(get.current(), 1);
});

test("lazy: a failed attempt is forgotten and the next call retries", async () => {
  let calls = 0;
  const get = lazy(async () => {
    calls++;
    if (calls === 1) throw new Error("boom");
    return "ok";
  });
  await assert.rejects(get(), /boom/);
  assert.equal(get.current(), undefined);
  assert.equal(await get(), "ok");
  assert.equal(calls, 2);
});

test("lazy: synchronous throw in the factory becomes a rejection", async () => {
  const get = lazy(() => {
    throw new Error("sync");
  });
  await assert.rejects(get(), /sync/);
});

test("lazy: reset forgets the value so the next call rebuilds it", async () => {
  let calls = 0;
  const get = lazy(async () => ++calls);
  assert.equal(await get(), 1);
  get.reset();
  assert.equal(get.current(), undefined);
  assert.equal(await get(), 2);
  assert.equal(get.current(), 2);
});

test("lazy: an attempt still in flight during reset does not overwrite the new value", async () => {
  let release;
  let calls = 0;
  const get = lazy(() => {
    calls++;
    if (calls === 1) return new Promise((resolve) => (release = resolve));
    return "fresh";
  });
  const stale = get();
  get.reset();
  assert.equal(await get(), "fresh");
  release("stale");
  assert.equal(await stale, "stale");
  assert.equal(get.current(), "fresh");
});

test("RingBuffer: keeps insertion order below capacity", () => {
  const buf = new RingBuffer(3);
  buf.push(1);
  buf.push(2);
  assert.equal(buf.length, 2);
  assert.deepEqual(buf.latest(10), [1, 2]);
});

test("RingBuffer: wraps around, dropping the oldest entries", () => {
  const buf = new RingBuffer(3);
  for (let i = 1; i <= 7; i++) buf.push(i);
  assert.equal(buf.length, 3);
  assert.deepEqual(buf.latest(10), [5, 6, 7]);
  assert.deepEqual(buf.latest(2), [6, 7]);
});

test("RingBuffer: latest with a predicate returns the newest matches, oldest first", () => {
  const buf = new RingBuffer(5);
  for (let i = 1; i <= 8; i++) buf.push(i); // holds 4..8
  assert.deepEqual(buf.latest(10, (n) => n % 2 === 0), [4, 6, 8]);
  assert.deepEqual(buf.latest(2, (n) => n % 2 === 0), [6, 8]);
  assert.deepEqual(buf.latest(10, () => false), []);
  assert.deepEqual(buf.latest(0), []);
});

test("RingBuffer: clear returns the removed count and empties the buffer", () => {
  const buf = new RingBuffer(2);
  buf.push("a");
  buf.push("b");
  buf.push("c");
  assert.equal(buf.clear(), 2);
  assert.equal(buf.length, 0);
  assert.deepEqual(buf.latest(5), []);
  buf.push("d");
  assert.deepEqual(buf.latest(5), ["d"]);
});

test("closeTunnel: tolerates undefined and direct (non-tunnel) targets", () => {
  assert.doesNotThrow(() => closeTunnel(undefined));
  assert.doesNotThrow(() => closeTunnel(null));
  assert.doesNotThrow(() => closeTunnel({ host: "db", port: 3306 }));
});

test("closeTunnel: closes every server and connection, even if one throws", () => {
  const calls = [];
  closeTunnel({
    tunnelServers: [
      { close: () => { calls.push("s1"); throw new Error("x"); } },
      { close: () => calls.push("s2") }
    ],
    sshConnections: [
      { end: () => { calls.push("c1"); throw new Error("y"); } },
      { end: () => calls.push("c2") }
    ]
  });
  assert.deepEqual(calls, ["s1", "s2", "c1", "c2"]);
});
