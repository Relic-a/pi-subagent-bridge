import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface RpcEvent {
  event?: string;
  method?: string;
  params?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PiClientOptions {
  executable: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onEvent?: (event: RpcEvent) => void;
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  onMalformedLine?: (line: string) => void;
}

export class PiRpcClient {
  readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(private options: PiClientOptions) {
    this.child = spawn(
      options.executable,
      options.args ?? ["--mode", "rpc", "--no-session"],
      {
        cwd: options.cwd,
        env: { ...process.env, ...options.env },
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    this.child.on("error", (error) => {
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
      options.onExit?.(null, null);
    });
    this.child.on("exit", (code, signal) => {
      for (const pending of this.pending.values()) {
        pending.reject(
          new Error(
            `Pi RPC process exited before response: code=${code} signal=${signal}`,
          ),
        );
      }
      this.pending.clear();
      options.onExit?.(code, signal);
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
  }

  request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = String(this.nextId++);
    const payload = { id, type: method, ...(params ?? {}) };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  send(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(
      `${JSON.stringify({ type: method, ...(params ?? {}) })}\n`,
    );
  }

  terminate(signal: NodeJS.Signals = "SIGTERM"): void {
    if (this.child.pid) {
      try {
        process.kill(-this.child.pid, signal);
      } catch {
        this.child.kill(signal);
      }
    }
  }

  private handleLine(line: string): void {
    let message: RpcEvent & {
      id?: string | number;
      type?: string;
      result?: unknown;
      error?: unknown;
      success?: boolean;
      data?: unknown;
    };
    try {
      message = JSON.parse(line);
    } catch {
      this.options.onMalformedLine?.(line);
      return;
    }

    const id = message.id === undefined ? undefined : String(message.id);
    if (id !== undefined && this.pending.has(id)) {
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (!pending) return;
      if (message.success === false || message.error)
        pending.reject(
          new Error(
            typeof message.error === "string"
              ? message.error
              : JSON.stringify(message.error ?? message),
          ),
        );
      else pending.resolve(message.data ?? message.result);
      return;
    }

    this.options.onEvent?.(message);
  }
}
