import { readFileSync } from "fs";
import { createTunnel } from "tunnel-ssh";

function resolvePrivateKey(sshConfig) {
  if (sshConfig.password?.trim()) {
    return undefined;
  }
  if (sshConfig.privateKey?.trim()) {
    return sshConfig.privateKey.replace(/\\n/g, "\n");
  }
  if (sshConfig.privateKeyPath?.trim()) {
    const path = sshConfig.privateKeyPath.replace(
      /^~/,
      process.env.HOME || process.env.USERPROFILE || ""
    );
    return readFileSync(path, "utf8");
  }
  return undefined;
}

function normalizeSshHopConfig(hop = {}) {
  return {
    host: hop.host,
    port: parseInt(String(hop.port || "22"), 10),
    user: hop.user,
    password: hop.password,
    privateKeyPath: hop.privateKeyPath,
    privateKey: hop.privateKey
  };
}

function parseSshJumps(value, envKeyName = "SSH_JUMPS") {
  if (!value || !String(value).trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      throw new Error(`${envKeyName} must be a JSON array`);
    }
    return parsed.map((hop) => normalizeSshHopConfig(hop));
  } catch (error) {
    throw new Error(`${envKeyName} format error: ${error.message}`);
  }
}

export function getSshConfigFromEnv(env = process.env, servicePrefix) {
  const scopedKey = servicePrefix ? `${servicePrefix}_SSH_JUMPS` : null;
  const rawJumpsValue = scopedKey ? env[scopedKey] || env.SSH_JUMPS : env.SSH_JUMPS;
  const keyName = scopedKey && env[scopedKey] ? scopedKey : "SSH_JUMPS";
  return {
    jumps: parseSshJumps(rawJumpsValue, keyName)
  };
}

export function useSshTunnel(sshConfig) {
  return sshConfig.jumps.some((hop) => {
    const hasSshHost = Boolean(hop.host?.trim());
    const hasSshUser = Boolean(hop.user?.trim());
    const hasSshAuth =
      Boolean(hop.password?.trim()) ||
      Boolean(hop.privateKeyPath?.trim()) ||
      Boolean(hop.privateKey?.trim());

    return hasSshHost && hasSshUser && hasSshAuth;
  });
}

export function buildSshOptions(sshConfig) {
  const options = {
    host: sshConfig.host,
    port: sshConfig.port,
    username: sshConfig.user
  };

  if (sshConfig.password?.trim()) {
    options.password = sshConfig.password;
  } else {
    const privateKey = resolvePrivateKey(sshConfig);
    if (privateKey) {
      options.privateKey = privateKey;
    }
  }

  return options;
}

export async function createSshForwardTunnel({ sshConfig, dstAddr, dstPort }) {
  const validHops = sshConfig.jumps.filter((hop) => useSshTunnel({ jumps: [hop] }));
  if (validHops.length === 0) {
    return { host: dstAddr, port: dstPort };
  }

  console.error(
    `[ssh-tunnel] Creating multi-hop tunnel, total hops: ${validHops.length}, target: ${dstAddr}:${dstPort}`
  );

  let previousLocalPort = null;
  for (let idx = 0; idx < validHops.length; idx += 1) {
    const hop = validHops[idx];
    const hopNo = idx + 1;
    const totalHops = validHops.length;
    const connectHost = previousLocalPort == null ? hop.host : "127.0.0.1";
    const connectPort = previousLocalPort == null ? hop.port : previousLocalPort;
    const forwardTarget =
      idx < validHops.length - 1
        ? { host: validHops[idx + 1].host, port: validHops[idx + 1].port }
        : { host: dstAddr, port: dstPort };

    console.error(
      `[ssh-tunnel] Preparing hop ${hopNo}/${totalHops}: connect ${connectHost}:${connectPort} as ${hop.user} -> forward ${forwardTarget.host}:${forwardTarget.port}`
    );

    const tunnelOptions = { autoClose: false, reconnectOnError: false };
    const serverOptions = { host: "127.0.0.1", port: 0 };
    const sshOptions = buildSshOptions({
      ...hop,
      host: connectHost,
      port: connectPort
    });
    const forwardOptions = {
      dstAddr: forwardTarget.host,
      dstPort: forwardTarget.port
    };

    let tunnelServer;
    try {
      [tunnelServer] = await createTunnel(
        tunnelOptions,
        serverOptions,
        sshOptions,
        forwardOptions
      );
    } catch (error) {
      throw new Error(
        `[ssh-tunnel] Hop ${hopNo}/${totalHops} failed (connect ${connectHost}:${connectPort} as ${hop.user} -> forward ${forwardTarget.host}:${forwardTarget.port}): ${error.message}`
      );
    }

    previousLocalPort = tunnelServer.address().port;
    console.error(
      `[ssh-tunnel] Hop ${hopNo}/${totalHops} succeeded, local forward: 127.0.0.1:${previousLocalPort}`
    );
  }

  console.error(
    `[ssh-tunnel] Multi-hop tunnel ready, use local endpoint: 127.0.0.1:${previousLocalPort}`
  );
  return {
    host: "127.0.0.1",
    port: previousLocalPort
  };
}
