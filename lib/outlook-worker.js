import { spawn } from "child_process";
import readline from "readline";

// JSON with every non-ASCII character \u-escaped, so the PowerShell side can read
// stdin without caring about its console input encoding.
function asciiJson(value) {
  return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
}

// One long-running `outlook.ps1 serve` process. Requests are newline-delimited JSON
// matched to responses by id. Starting PowerShell and attaching to Outlook over COM
// costs ~0.5 s, so it is paid once instead of per tool call; the script also caches
// the mailbox folder list between requests.
//
// - Started lazily on the first request.
// - A request that times out kills the process (it is stuck); the next request starts a new one.
// - Stopped after `idleMs` without requests, which releases the COM reference to Outlook.
export class OutlookWorker {
  constructor({ command, scriptPath, timeoutMs, idleMs, env }) {
    Object.assign(this, { command, scriptPath, timeoutMs, idleMs, env });
    this.proc = null;
    this.pending = new Map();
    this.nextId = 1;
    this.idleTimer = null;
  }

  request(action, params = {}) {
    clearTimeout(this.idleTimer);
    if (!this.proc) this.start();

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Outlook 回應逾時（${this.timeoutMs} ms）`));
        this.stop("前一個請求逾時，Outlook 程序已重啟");
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc.stdin.write(`${asciiJson({ id, action, params })}\n`);
    });
  }

  start() {
    const proc = spawn(
      this.command,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.scriptPath, "serve"],
      { windowsHide: true, env: this.env, stdio: ["pipe", "pipe", "pipe"] }
    );
    this.proc = proc;

    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    proc.stdout.setEncoding("utf8");
    readline.createInterface({ input: proc.stdout }).on("line", (line) => this.onLine(line));
    proc.stdin.on("error", () => {}); // EPIPE after the process died; reported via "exit".
    proc.on("error", (err) => this.fail(proc, err));
    proc.on("exit", (code) => {
      this.fail(proc, new Error(`Outlook PowerShell 程序已結束（code ${code}）${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  }

  onLine(line) {
    const start = line.indexOf("{");
    if (start < 0) return;
    let msg;
    try {
      msg = JSON.parse(line.slice(start));
    } catch {
      return; // Not one of our responses (stray PowerShell output).
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return; // Already timed out.
    this.pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.ok) {
      entry.resolve(msg.data);
    } else {
      entry.reject(new Error(msg.error));
    }

    if (this.pending.size === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.stop(), this.idleMs);
      this.idleTimer.unref();
    }
  }

  // Reject everything still waiting on `proc` and forget it.
  fail(proc, err) {
    if (this.proc !== proc) return;
    this.proc = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }

  stop(reason = "Outlook 程序已停止") {
    clearTimeout(this.idleTimer);
    const proc = this.proc;
    if (!proc) return;
    this.fail(proc, new Error(reason));
    proc.stdin.end(); // Lets the script leave its read loop and exit cleanly.
    setTimeout(() => proc.kill(), 3000).unref();
  }
}
