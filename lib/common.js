import fs from "fs";
import dotenv from "dotenv";

// Parse an env file into a plain object (does not touch process.env).
export function loadEnvFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  return dotenv.parse(fs.readFileSync(filePath));
}

export function parseBooleanFlag(value, defaultValue = true) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

export function assertOperationAllowed(operationName, allowed) {
  if (!allowed) {
    throw new Error(`Operation not allowed: ${operationName}`);
  }
}

// Memoize an async factory. A failed attempt is forgotten so the next call retries.
// `get.current()` returns the resolved value, or undefined if not ready yet.
export function lazy(factory) {
  let promise = null;
  let value;

  const get = () => {
    if (!promise) {
      promise = Promise.resolve()
        .then(factory)
        .then((result) => {
          value = result;
          return result;
        })
        .catch((err) => {
          promise = null;
          throw err;
        });
    }
    return promise;
  };

  get.current = () => value;
  return get;
}

export function closeTunnel(tunnelTarget) {
  for (const tunnelServer of tunnelTarget?.tunnelServers ?? []) {
    try {
      tunnelServer.close();
    } catch {
      // Ignore close errors on shutdown.
    }
  }
}
