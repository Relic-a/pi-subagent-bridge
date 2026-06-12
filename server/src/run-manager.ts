import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PiRpcClient, type RpcEvent } from "./pi-rpc-client.js";
import { redactSecrets } from "./redaction.js";
import { ToolCallStore } from "./tool-call-store.js";
import type {
  ActiveRun,
  RunDiagnostics,
  RunResult,
  RunState,
  StartRunInput,
  ToolCallAudit,
} from "./types.js";

const TERMINAL_STATES = new Set<RunState>([
  "completed",
  "failed",
  "stopped",
  "timed_out",
]);
const ALLOWED_TRANSITIONS: Record<RunState, RunState[]> = {
  starting: ["running", "completed", "failed", "stopping", "timed_out"],
  running: ["completed", "failed", "stopping", "timed_out"],
  completed: [],
  failed: [],
  stopping: ["stopped", "failed", "timed_out"],
  stopped: [],
  timed_out: [],
};

export interface RunManagerOptions {
  store: ToolCallStore;
  piExecutable: string;
  piArgs?: string[];
  allowedRoots: string[];
  maxConcurrentRuns: number;
  maxRuntimeMs: number;
  stopGraceMs: number;
  startMethod: string;
  abortMethod: string;
}

export class RunManager {
  private active = new Map<string, ActiveRun>();
  private shuttingDown = false;

  constructor(private options: RunManagerOptions) {}

  async start(input: StartRunInput): Promise<{ run_id: string }> {
    if (this.active.size >= this.options.maxConcurrentRuns) {
      throw new Error(
        `Concurrency limit reached (${this.options.maxConcurrentRuns}).`,
      );
    }
    const cwd = this.validateWorkingDirectory(input.working_directory);
    const runId = crypto.randomUUID();
    const now = new Date().toISOString();
    let resolveOnce!: (result: RunResult) => void;
    const waitPromise = new Promise<RunResult>((resolve) => {
      let resolved = false;
      resolveOnce = (result) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };
    });

    const client = new PiRpcClient({
      executable: this.options.piExecutable,
      args: this.argsFor(input),
      cwd,
      onEvent: (event) => this.handleEvent(runId, event),
      onExit: (code, signal) => this.handleExit(runId, code, signal),
      onMalformedLine: (line) => {
        this.failRun(runId, `Malformed Pi JSONL output: ${line.slice(0, 160)}`);
      },
    });
    const run: ActiveRun = {
      run_id: runId,
      child: client.child,
      state: "starting",
      startedAtMs: Date.now(),
      waitPromise,
      resolveOnce,
      stopRequested: false,
      abortSent: false,
    };
    (run as ActiveRun & { client: PiRpcClient }).client = client;
    this.active.set(runId, run);
    this.options.store.createRun({
      run_id: runId,
      task: input.task,
      state: "starting",
      created_at: now,
      updated_at: now,
      working_directory: cwd,
      provider: input.provider,
      model_id: input.model_id,
      thinking_level: input.thinking_level,
    });

    run.timeoutTimer = setTimeout(() => {
      this.transition(runId, "timed_out", {
        error: "Pi run exceeded maximum runtime.",
      });
      this.killRun(run, "SIGTERM");
      run.resolveOnce({
        run_id: runId,
        state: "timed_out",
        final_answer: "",
        error: "Maximum runtime exceeded.",
      });
      this.active.delete(runId);
    }, this.options.maxRuntimeMs);

    client
      .request(this.options.startMethod, {
        message: input.task,
      })
      .then(() => this.transition(runId, "running"))
      .catch((error) => {
        const active = this.active.get(runId);
        if (active?.state === "stopping") return;
        this.failRun(runId, `Pi start failed: ${error.message}`);
      });

    return { run_id: runId };
  }

  wait(runId: string): Promise<RunResult> {
    const active = this.active.get(runId);
    if (active) return active.waitPromise;
    const record = this.options.store.getRun(runId);
    if (!record) throw new Error(`Unknown run_id: ${runId}`);
    if (!TERMINAL_STATES.has(record.state))
      throw new Error(`Run ${runId} is not active but is ${record.state}.`);
    return Promise.resolve({
      run_id: runId,
      state: record.state as RunResult["state"],
      final_answer: record.final_answer ?? "",
      error: record.error,
    });
  }

  async stop(runId: string): Promise<RunDiagnostics> {
    const active = this.active.get(runId);
    if (!active) return this.getRun(runId);
    if (TERMINAL_STATES.has(active.state)) return this.getRun(runId);
    if (!active.stopRequested) {
      active.stopRequested = true;
      this.transition(runId, "stopping");
      this.clientFor(active).send(this.options.abortMethod, { run_id: runId });
      active.abortSent = true;
      active.forceTimer = setTimeout(() => {
        this.killRun(active, "SIGTERM");
        setTimeout(() => {
          if (this.active.has(runId)) {
            this.killRun(active, "SIGKILL");
            this.transition(runId, "stopped");
            active.resolveOnce({
              run_id: runId,
              state: "stopped",
              final_answer: "",
            });
            this.cleanup(runId);
          }
        }, 500);
      }, this.options.stopGraceMs);
    }
    return this.getRun(runId);
  }

  getRun(runId: string): RunDiagnostics {
    const record = this.options.store.getRun(runId);
    if (!record) throw new Error(`Unknown run_id: ${runId}`);
    return {
      run_id: record.run_id,
      state: record.state,
      created_at: record.created_at,
      updated_at: record.updated_at,
      working_directory: record.working_directory,
      provider: record.provider,
      model_id: record.model_id,
      thinking_level: record.thinking_level,
      error: record.error,
      has_result: Boolean(record.final_answer),
    };
  }

  readResult(runId: string): RunResult {
    const record = this.options.store.getRun(runId);
    if (!record) throw new Error(`Unknown run_id: ${runId}`);
    if (!TERMINAL_STATES.has(record.state))
      throw new Error(`Run ${runId} has not completed.`);
    return {
      run_id: runId,
      state: record.state as RunResult["state"],
      final_answer: record.final_answer ?? "",
      error: record.error,
    };
  }

  recentToolCalls(limit?: number, runId?: string): ToolCallAudit[] {
    return this.options.store.recentToolCalls(limit, runId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runs = [...this.active.values()];
    for (const run of runs) {
      this.clientFor(run).send(this.options.abortMethod, {
        run_id: run.run_id,
      });
      this.killRun(run, "SIGTERM");
      this.transition(
        run.run_id,
        run.state === "stopping" ? "stopped" : "stopping",
      );
      this.transition(run.run_id, "stopped");
      run.resolveOnce({
        run_id: run.run_id,
        state: "stopped",
        final_answer: "",
      });
      this.cleanup(run.run_id);
    }
    this.options.store.close();
  }

  private handleEvent(runId: string, event: RpcEvent): void {
    if (this.shuttingDown) return;
    const name = String(event.event ?? event.method ?? event.type ?? "");
    const params =
      event.params && typeof event.params === "object" ? event.params : event;
    if (name === "tool_execution_start") {
      this.options.store.addToolCall({
        timestamp: new Date().toISOString(),
        run_id: runId,
        pi_tool_call_id: String(
          params.tool_call_id ?? params.toolCallId ?? params.id ?? "unknown",
        ),
        tool_name: String(
          params.tool_name ?? params.toolName ?? params.name ?? "unknown",
        ),
        arguments:
          (params.arguments ?? params.args) === undefined
            ? undefined
            : redactSecrets(params.arguments ?? params.args),
      });
    }
    if (name === "agent_end") {
      const active = this.active.get(runId);
      const requestedState = String(
        params.state ?? params.status ?? "completed",
      ) as RunState;
      const state: RunResult["state"] =
        active?.state === "stopping"
          ? "stopped"
          : requestedState === "failed"
            ? "failed"
            : "completed";
      const finalAnswer = String(
        params.final_answer ??
          params.answer ??
          params.message ??
          extractFinalAnswer(params.messages) ??
          "",
      );
      this.transition(runId, state, {
        final_answer: state === "completed" ? finalAnswer : undefined,
        error:
          state === "failed"
            ? String(params.error ?? "Pi run failed.")
            : undefined,
      });
      active?.resolveOnce({
        run_id: runId,
        state,
        final_answer: finalAnswer,
        error:
          state === "failed"
            ? String(params.error ?? "Pi run failed.")
            : undefined,
      });
      if (active) this.killRun(active, "SIGTERM");
      this.cleanup(runId);
    }
  }

  private handleExit(
    runId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (this.shuttingDown) return;
    const active = this.active.get(runId);
    if (!active || TERMINAL_STATES.has(active.state)) return;
    if (active.state === "stopping") {
      this.transition(runId, "stopped");
      active.resolveOnce({ run_id: runId, state: "stopped", final_answer: "" });
    } else {
      this.transition(runId, "failed", {
        error: `Pi process exited unexpectedly: code=${code} signal=${signal}`,
      });
      active.resolveOnce({
        run_id: runId,
        state: "failed",
        final_answer: "",
        error: `Pi process exited unexpectedly: code=${code} signal=${signal}`,
      });
    }
    this.cleanup(runId);
  }

  private failRun(runId: string, error: string): void {
    const active = this.active.get(runId);
    if (!active || TERMINAL_STATES.has(active.state)) return;
    if (active.state === "stopping") return;
    this.transition(runId, "failed", { error });
    active.resolveOnce({
      run_id: runId,
      state: "failed",
      final_answer: "",
      error,
    });
    this.cleanup(runId);
  }

  private transition(
    runId: string,
    next: RunState,
    fields?: { error?: string; final_answer?: string },
  ): void {
    const active = this.active.get(runId);
    const current = active?.state ?? this.options.store.getRun(runId)?.state;
    if (!current) throw new Error(`Unknown run_id: ${runId}`);
    if (current === next) return;
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new Error(`Invalid run state transition: ${current} -> ${next}`);
    }
    if (active) active.state = next;
    this.options.store.updateRun(runId, next, fields);
    process.stderr.write(
      JSON.stringify({
        level: "info",
        event: "run_state",
        run_id: runId,
        state: next,
      }) + "\n",
    );
  }

  private validateWorkingDirectory(input: string): string {
    if (!input || input.includes("\0"))
      throw new Error("Invalid working_directory.");
    const parts = input.split(/[\\/]+/);
    if (parts.includes(".."))
      throw new Error("Path traversal is not allowed in working_directory.");
    const resolved = path.resolve(input);
    const allowed = this.options.allowedRoots.map((root) => path.resolve(root));
    if (
      !allowed.some(
        (root) =>
          resolved === root || resolved.startsWith(`${root}${path.sep}`),
      )
    ) {
      throw new Error(
        `working_directory must be under an allowed root: ${allowed.join(", ")}`,
      );
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory())
      throw new Error("working_directory must be an existing directory.");
    return resolved;
  }

  private clientFor(run: ActiveRun): PiRpcClient {
    return (run as ActiveRun & { client: PiRpcClient }).client;
  }

  private argsFor(input: StartRunInput): string[] | undefined {
    const args = [...(this.options.piArgs ?? [])];
    if (input.provider) args.push("--provider", input.provider);
    if (input.model_id)
      args.push(
        "--model",
        input.provider && !input.model_id.includes("/")
          ? `${input.provider}/${input.model_id}`
          : input.model_id,
      );
    if (input.thinking_level) args.push("--thinking", input.thinking_level);
    return args.length > 0 ? args : undefined;
  }

  private killRun(run: ActiveRun, signal: NodeJS.Signals): void {
    this.clientFor(run).terminate(signal);
  }

  private cleanup(runId: string): void {
    const run = this.active.get(runId);
    if (!run) return;
    if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
    if (run.forceTimer) clearTimeout(run.forceTimer);
    this.active.delete(runId);
  }
}

function extractFinalAnswer(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    const text = textFromContent(message.content);
    if (text) return text;
  }
  return undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!isRecord(part)) return "";
      return typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : "";
    })
    .filter(Boolean)
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
