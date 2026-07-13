import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export class PiRpcClient {
    options;
    child;
    nextId = 1;
    exited = false;
    stderrTail = "";
    pending = new Map();
    constructor(options) {
        this.options = options;
        const inheritedPath = options.env?.PATH ?? process.env.PATH ?? "";
        this.child = spawn(options.executable, options.args ?? ["--mode", "rpc"], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env, PATH: inheritedPath },
            detached: true,
            stdio: ["pipe", "pipe", "pipe"],
        });
        this.child.stderr.on("data", (chunk) => {
            const output = String(chunk);
            this.stderrTail = `${this.stderrTail}${output}`.slice(-16 * 1024);
            for (const line of output.split(/\r?\n/).filter(Boolean)) {
                process.stderr.write(`[pi-rpc] ${line}\n`);
            }
        });
        this.child.stdin.on("error", () => undefined);
        this.child.on("error", (error) => {
            for (const pending of this.pending.values()) {
                if (pending.timer)
                    clearTimeout(pending.timer);
                pending.reject(error);
            }
            this.pending.clear();
            options.onExit?.(null, null, error);
        });
        this.child.on("exit", (code, signal) => {
            this.exited = true;
            const error = new Error(this.exitErrorMessage(code, signal));
            for (const pending of this.pending.values()) {
                if (pending.timer)
                    clearTimeout(pending.timer);
                pending.reject(error);
            }
            this.pending.clear();
            options.onExit?.(code, signal, error);
        });
        const lines = createInterface({ input: this.child.stdout });
        lines.on("line", (line) => this.handleLine(line));
    }
    request(method, params) {
        const id = String(this.nextId++);
        const payload = { id, type: method, ...(params ?? {}) };
        return new Promise((resolve, reject) => {
            if (this.exited || !this.child.stdin.writable) {
                reject(new Error("Pi RPC process is not accepting input."));
                return;
            }
            this.pending.set(id, { resolve, reject });
            const pending = this.pending.get(id);
            const timeoutMs = this.options.requestTimeoutMs;
            if (pending && timeoutMs && timeoutMs > 0) {
                pending.timer = setTimeout(() => {
                    if (!this.pending.delete(id))
                        return;
                    reject(new Error(`Pi RPC request timed out after ${timeoutMs}ms: ${method}`));
                }, timeoutMs);
            }
            this.child.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
                if (error) {
                    this.pending.delete(id);
                    if (pending?.timer)
                        clearTimeout(pending.timer);
                    reject(error);
                }
            });
        });
    }
    send(method, params) {
        if (this.exited || !this.child.stdin.writable)
            return false;
        try {
            return this.child.stdin.write(`${JSON.stringify({ type: method, ...(params ?? {}) })}\n`);
        }
        catch {
            return false;
        }
    }
    terminate(signal = "SIGTERM") {
        if (this.exited)
            return;
        if (this.child.pid) {
            try {
                process.kill(-this.child.pid, signal);
            }
            catch {
                this.child.kill(signal);
            }
        }
    }
    handleLine(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            if (this.options.ignoreNonJsonNoise)
                return;
            this.options.onMalformedLine?.(line);
            return;
        }
        const id = message.id === undefined ? undefined : String(message.id);
        if (id !== undefined && this.pending.has(id)) {
            const pending = this.pending.get(id);
            this.pending.delete(id);
            if (!pending)
                return;
            if (pending.timer)
                clearTimeout(pending.timer);
            if (message.success === false || message.error)
                pending.reject(new Error(typeof message.error === "string"
                    ? message.error
                    : JSON.stringify(message.error ?? message)));
            else
                pending.resolve(message.data ?? message.result);
            return;
        }
        this.options.onEvent?.(message);
    }
    exitErrorMessage(code, signal) {
        const message = `Pi RPC process exited before response: code=${code} signal=${signal}`;
        const stderr = this.stderrTail.trim();
        return stderr ? `${message}\nstderr: ${stderr}` : message;
    }
}
