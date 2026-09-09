import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import { EventEmitter } from "node:events";

export function childEnvironment(home: string): NodeJS.ProcessEnv {
  // Construct an allowlist instead of trying to enumerate every project secret.
  const env: NodeJS.ProcessEnv = { CODEX_HOME: home };
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}
export class AppServer extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private lines?: Interface;
  private sequence = 0;
  private pending = new Map<
    number,
    {
      resolve: (x: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private completed = new Map<string, any>();
  constructor(
    private executable: string,
    private home: string,
    private cwd: string,
  ) {
    super();
  }
  async start() {
    this.child = spawn(this.executable, ["app-server"], {
      cwd: this.cwd,
      env: childEnvironment(this.home),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", () =>
      this.fail(new Error("Codex app-server exited")),
    );
    this.child.stderr.on("data", (chunk) =>
      this.emit("diagnostic", chunk.toString()),
    );
    this.lines = createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("diagnostic", "Non-JSON app-server output");
        return;
      }
      const request = this.pending.get(message.id);
      if (request && !message.method) {
        clearTimeout(request.timer);
        this.pending.delete(message.id);
        message.error
          ? request.reject(new Error(JSON.stringify(message.error)))
          : request.resolve(message.result);
      } else if (message.id !== undefined && message.method) {
        // Public conversations never authorize host approvals, elicitation or
        // arbitrary dynamic tools. Deny at the runner boundary as well as hooks.
        this.child?.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Interactive host authorization is unavailable in HELP workers",
            },
          }) + "\n",
        );
        this.emit("attention", { method: message.method });
      } else if (message.method) {
        this.notification(message.method, message.params);
      }
    });
    await this.request("initialize", {
      clientInfo: { name: "spawnbox_help", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  }
  private notification(method: string, params: any) {
    if (method === "turn/completed") {
      this.completed.set(params.turn.id, params.turn);
      if (this.completed.size > 1000)
        this.completed.delete(this.completed.keys().next().value!);
    }
    // Native `error` is a turn notification, not EventEmitter's fatal `error`
    // event. Keep retry notifications informational; turn/completed determines
    // when a turn has actually stopped and can safely be retried or blocked.
    this.emit(method === "error" ? "turn/error" : method, params);
  }
  private fail(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("disconnected", error);
  }
  request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.exitCode !== null)
        return reject(new Error("App-server is not running"));
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`App-server request timed out: ${method}`));
      }, 45000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }
  async waitTurn(id: string, timeout = 600000): Promise<any> {
    const existing = this.completed.get(id);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const clean = () => {
        clearTimeout(timer);
        this.off("turn/completed", done);
        this.off("disconnected", failed);
      };
      const done = (event: any) => {
        if (event.turn.id === id) {
          clean();
          resolve(event.turn);
        }
      };
      const failed = (error: Error) => {
        clean();
        reject(error);
      };
      const timer = setTimeout(() => {
        clean();
        reject(new Error("Codex turn timed out"));
      }, timeout);
      this.on("turn/completed", done);
      this.on("disconnected", failed);
    });
  }
  async stop() {
    this.child?.stdin.end();
    await Promise.race([
      new Promise<void>((r) => this.child?.once("exit", () => r())),
      Bun.sleep(1000),
    ]);
    this.child?.kill();
    this.lines?.close();
    this.child?.stdout.destroy();
    this.child?.stderr.destroy();
    this.child?.unref();
    this.fail(new Error("App-server stopped"));
  }
}
