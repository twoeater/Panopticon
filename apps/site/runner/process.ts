import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
export function terminate(child: ChildProcess) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32")
    spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    }).unref();
  else child.kill("SIGKILL");
}
export async function runProcess(
  binary: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxOutput?: number;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd: options.cwd,
      env: (options.env || process.env) as NodeJS.ProcessEnv,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (error) {
        terminate(child);
        reject(error);
      } else resolve({ stdout, stderr });
    };
    const abort = () => finish(new Error("실행이 취소되었습니다."));
    const timer = setTimeout(
      () => finish(new Error("실행 제한 시간을 초과했습니다.")),
      options.timeoutMs || 180000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > (options.maxOutput || 1000000))
        finish(new Error("출력 제한을 초과했습니다."));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`프로세스 종료 ${code}: ${stderr.slice(-1000)}`),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
  });
}
export class RpcProcess {
  child: ChildProcess;
  pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  sequence = 0;
  onEvent: (message: any) => void = () => {};
  closed = false;
  constructor(binary: string, args: string[], cwd: string) {
    this.child = spawn(binary, args, {
      cwd,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin!.on("error", () => {});
    this.child.stderr!.on("data", () => {});
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (line.length > 2000000)
        return this.close(new Error("RPC 출력 제한 초과"));
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && !msg.method) {
          const pending = this.pending.get(msg.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(msg.id);
            if (msg.error)
              pending.reject(new Error(msg.error.message || "RPC 오류"));
            else pending.resolve(msg.result);
          }
        } else if (msg.method && msg.id !== undefined)
          this.send({
            id: msg.id,
            jsonrpc: "2.0",
            error: {
              code: -32601,
              message:
                "This integration does not grant tool execution permissions.",
            },
          });
        else this.onEvent(msg);
      } catch {
        /* Non-protocol logs do not become chat messages. */
      }
    });
    this.child.on("error", (error) => this.close(error));
    this.child.on("exit", () =>
      this.close(new Error("CLI 연결이 종료되었습니다.")),
    );
  }
  send(value: unknown) {
    this.child.stdin!.write(JSON.stringify(value) + "\n");
  }
  request(method: string, params: unknown, timeout = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("RPC 연결 종료"));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 시간 초과`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }
  close(error = new Error("RPC 연결 종료")) {
    if (this.closed) return;
    this.closed = true;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    this.pending.clear();
    terminate(this.child);
  }
}
