import test from "node:test";
import assert from "node:assert/strict";
import { getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";

const hop = { host: "bastion", port: 2222, user: "ops", password: "pw" };

test("getSshConfigFromEnv: no SSH_JUMPS means no hops", () => {
  assert.deepEqual(getSshConfigFromEnv({}), { jumps: [] });
  assert.deepEqual(getSshConfigFromEnv({ SSH_JUMPS: "  " }), { jumps: [] });
});

test("getSshConfigFromEnv: parses and normalizes hops (port defaults to 22)", () => {
  const env = { SSH_JUMPS: JSON.stringify([hop, { host: "inner", user: "u", privateKeyPath: "~/.ssh/id" }]) };
  assert.deepEqual(getSshConfigFromEnv(env).jumps, [
    { host: "bastion", port: 2222, user: "ops", password: "pw", privateKeyPath: undefined, privateKey: undefined },
    { host: "inner", port: 22, user: "u", password: undefined, privateKeyPath: "~/.ssh/id", privateKey: undefined }
  ]);
});

test("getSshConfigFromEnv: a service-scoped key wins over SSH_JUMPS", () => {
  const env = {
    SSH_JUMPS: JSON.stringify([{ host: "global", user: "g", password: "p" }]),
    MYSQL_SSH_JUMPS: JSON.stringify([{ host: "scoped", user: "s", password: "p" }])
  };
  assert.equal(getSshConfigFromEnv(env, "MYSQL").jumps[0].host, "scoped");
  assert.equal(getSshConfigFromEnv(env, "MONGODB").jumps[0].host, "global");
  assert.equal(getSshConfigFromEnv(env).jumps[0].host, "global");
});

test("getSshConfigFromEnv: invalid JSON or a non-array names the offending key", () => {
  assert.throws(() => getSshConfigFromEnv({ SSH_JUMPS: "{nope" }), /^Error: SSH_JUMPS format error/);
  assert.throws(
    () => getSshConfigFromEnv({ TDENGINE_SSH_JUMPS: JSON.stringify({ host: "x" }) }, "TDENGINE"),
    /TDENGINE_SSH_JUMPS format error: TDENGINE_SSH_JUMPS must be a JSON array/
  );
});

test("useSshTunnel: needs host, user and some auth on at least one hop", () => {
  assert.equal(useSshTunnel({ jumps: [] }), false);
  assert.equal(useSshTunnel({ jumps: [hop] }), true);
  assert.equal(useSshTunnel({ jumps: [{ ...hop, password: undefined, privateKey: "KEY" }] }), true);
  assert.equal(useSshTunnel({ jumps: [{ ...hop, password: undefined, privateKeyPath: "~/.ssh/id" }] }), true);
  assert.equal(useSshTunnel({ jumps: [{ ...hop, password: "  " }] }), false);
  assert.equal(useSshTunnel({ jumps: [{ ...hop, host: "" }] }), false);
  assert.equal(useSshTunnel({ jumps: [{ ...hop, user: undefined }] }), false);
  assert.equal(useSshTunnel({ jumps: [{ host: "x" }, hop] }), true);
});
