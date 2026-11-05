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

// MCP tool results.
export const textResult = (text) => ({ content: [{ type: "text", text }] });
export const jsonResult = (value) => textResult(JSON.stringify(value, null, 2));
export const errorResult = (text) => ({ ...textResult(text), isError: true });

// Fixed-capacity FIFO: O(1) push, oldest entries are overwritten when full.
// (Array#shift on a full 10k-entry buffer is O(n) per incoming message.)
export class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.clear();
  }

  get length() {
    return this.size;
  }

  push(item) {
    this.items[(this.start + this.size) % this.capacity] = item;
    if (this.size < this.capacity) {
      this.size++;
    } else {
      this.start = (this.start + 1) % this.capacity;
    }
  }

  // The newest `limit` items that pass `predicate`, oldest first. Scans from the
  // newest end and stops early, so it never copies the whole buffer.
  latest(limit, predicate) {
    const out = [];
    for (let i = this.size - 1; i >= 0 && out.length < limit; i--) {
      const item = this.items[(this.start + i) % this.capacity];
      if (!predicate || predicate(item)) out.push(item);
    }
    return out.reverse();
  }

  clear() {
    const removed = this.size ?? 0;
    this.items = new Array(this.capacity);
    this.start = 0;
    this.size = 0;
    return removed;
  }
}
