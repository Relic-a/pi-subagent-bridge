import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
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
  RunWorkspace,
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
  piSessionDir?: string;
  allowedRoots: string[];
  maxRuntimeMs: number;
  stopGraceMs: number;
  startMethod: string;
  abortMethod: string;
  worktreeRootName?: string;
  sessionIdFlag?: string;
  noSessionFlag?: string;
}

export class RunManager {
  private active = new Map<string, ActiveRun>();
  private shuttingDown = false;

  constructor(private options: RunManagerOptions) {}

  async start(
    input: StartRunInput,
  ): Promise<{ run_id: string; session_id?: string; workspace: RunWorkspace }> {
    const cwd = this.validateWorkingDirectory(input.working_directory);
    const runId = crypto.randomUUID();
    const workspace = this.prepareWorkspace(cwd, runId, input.workspace_mode);
    const agentCwd = workspace.agent_working_directory;
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

    const sessionId = input.session_id;
    const sessionSnapshot = sessionId
      ? undefined
      : snapshotSessionFiles(this.sessionDirsFor(agentCwd));
    const client = new PiRpcClient({
      executable: this.options.piExecutable,
      args: this.argsFor(input),
      cwd: agentCwd,
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
    (run as ActiveRun & { sessionId?: string }).sessionId = sessionId;
    (
      run as ActiveRun & { sessionSnapshot?: Map<string, number> }
    ).sessionSnapshot = sessionSnapshot;
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
      session_id: sessionId,
      workspace,
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
        session_id: this.getRunSessionId(runId),
        workspace: this.finalizeWorkspace(runId),
      });
      this.active.delete(runId);
    }, this.options.maxRuntimeMs);

    client
      .request(this.options.startMethod, {
        message: this.messageForAgent(input.task, workspace),
      })
      .then((data) => {
        this.captureSessionId(runId, data);
        this.transition(runId, "running");
      })
      .catch((error) => {
        const active = this.active.get(runId);
        if (active?.state === "stopping") return;
        this.failRun(runId, `Pi start failed: ${error.message}`);
      });

    return { run_id: runId, session_id: sessionId, workspace };
  }

  wait(runId: string, timeoutMs?: number): Promise<RunResult> {
    const active = this.active.get(runId);
    if (active) {
      if (timeoutMs && timeoutMs > 0) {
        return this.waitWithProgress(active, timeoutMs);
      }
      return active.waitPromise;
    }
    const record = this.options.store.getRun(runId);
    if (!record) throw new Error(`Unknown run_id: ${runId}`);
    if (!TERMINAL_STATES.has(record.state))
      throw new Error(`Run ${runId} is not active but is ${record.state}.`);
    return Promise.resolve({
      run_id: runId,
      state: record.state as RunResult["state"],
      final_answer: record.final_answer ?? "",
      error: record.error,
      session_id: record.session_id,
      workspace: record.workspace,
    });
  }

  private async waitWithProgress(
    active: ActiveRun,
    timeoutMs: number,
  ): Promise<RunResult> {
    const runId = active.run_id;
    let progressTimer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        active.waitPromise,
        new Promise<RunResult>((resolve) => {
          progressTimer = setTimeout(() => {
            progressTimer = undefined;
            const toolCallsCount = this.options.store.recentToolCalls(
              undefined,
              runId,
            ).length;
            resolve({
              run_id: runId,
              state: active.state,
              final_answer: "",
              session_id: this.getRunSessionId(runId),
              progress: {
                elapsed_ms: Date.now() - active.startedAtMs,
                tool_calls_count: toolCallsCount,
              },
            });
          }, timeoutMs);
        }),
      ]);
      return result;
    } finally {
      if (progressTimer) clearTimeout(progressTimer);
    }
  }

  async stop(runId: string): Promise<RunDiagnostics> {
    const active = this.active.get(runId);
    if (!active) return this.getRun(runId);
    if (TERMINAL_STATES.has(active.state)) return this.getRun(runId);
    if (!active.stopRequested) {
      active.stopRequested = true;
      this.transition(runId, "stopping");
      active.abortSent = this.sendAbort(active);
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
              session_id: this.getRunSessionId(runId),
              workspace: this.finalizeWorkspace(runId),
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
      session_id: record.session_id,
      error: record.error,
      has_result: Boolean(record.final_answer),
      workspace: record.workspace,
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
      session_id: record.session_id,
      workspace: record.workspace,
    };
  }

  recentToolCalls(limit?: number, runId?: string): ToolCallAudit[] {
    return this.options.store.recentToolCalls(limit, runId);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const runs = [...this.active.values()];
    for (const run of runs) {
      this.sendAbort(run);
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
        session_id: this.getRunSessionId(run.run_id),
        workspace: this.finalizeWorkspace(run.run_id),
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
    if (name === "session_created" || name === "session_started") {
      const sid = extractSessionId(params);
      if (sid) {
        const run = this.active.get(runId);
        if (run) {
          (run as ActiveRun & { sessionId?: string }).sessionId = sid;
          this.options.store.updateRunSessionId(runId, sid);
        }
      }
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
      this.captureSessionId(runId, params);
      const sessionId = this.getRunSessionId(runId);
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
        session_id: sessionId,
        workspace: this.finalizeWorkspace(runId),
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
    const sessionId = this.getRunSessionId(runId);
    if (active.state === "stopping") {
      this.transition(runId, "stopped");
      active.resolveOnce({
        run_id: runId,
        state: "stopped",
        final_answer: "",
        session_id: sessionId,
        workspace: this.finalizeWorkspace(runId),
      });
    } else {
      this.transition(runId, "failed", {
        error: `Pi process exited unexpectedly: code=${code} signal=${signal}`,
      });
      active.resolveOnce({
        run_id: runId,
        state: "failed",
        final_answer: "",
        error: `Pi process exited unexpectedly: code=${code} signal=${signal}`,
        session_id: sessionId,
        workspace: this.finalizeWorkspace(runId),
      });
    }
    this.cleanup(runId);
  }

  private failRun(runId: string, error: string): void {
    const active = this.active.get(runId);
    if (!active || TERMINAL_STATES.has(active.state)) return;
    if (active.state === "stopping") return;
    const sessionId = this.getRunSessionId(runId);
    this.transition(runId, "failed", { error });
    active.resolveOnce({
      run_id: runId,
      state: "failed",
      final_answer: "",
      error,
      session_id: sessionId,
      workspace: this.finalizeWorkspace(runId),
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

  private prepareWorkspace(
    cwd: string,
    runId: string,
    mode: StartRunInput["workspace_mode"] = "auto",
  ): RunWorkspace {
    if (mode === "direct") {
      return {
        mode: "direct",
        original_working_directory: cwd,
        agent_working_directory: cwd,
      };
    }

    const git = this.gitContext(cwd);
    if (!git) {
      if (mode === "worktree") {
        throw new Error("workspace_mode=worktree requires a git working tree.");
      }
      return {
        mode: "direct",
        original_working_directory: cwd,
        agent_working_directory: cwd,
        setup_error: "No git working tree found; using direct workspace.",
      };
    }

    const runSlug = runId.slice(0, 8);
    const worktreeRootName =
      this.options.worktreeRootName ??
      process.env.PI_BRIDGE_WORKTREE_ROOT_NAME ??
      ".pi-subagent-runs";
    const worktreesRoot = path.join(git.repoRoot, worktreeRootName);
    const worktreePath = path.join(worktreesRoot, runId);
    const artifactsDir = path.join(worktreePath, ".pi-bridge");
    const branch = `pi/run-${runSlug}`;

    fs.mkdirSync(worktreesRoot, { recursive: true });
    this.git(git.repoRoot, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      git.baseCommit,
    ]);
    fs.mkdirSync(artifactsDir, { recursive: true });

    const relativeCwd = path.relative(git.repoRoot, cwd);
    const agentCwd = path.join(worktreePath, relativeCwd);
    const patchPath = path.join(artifactsDir, "changes.patch");

    return {
      mode: "worktree",
      original_working_directory: cwd,
      agent_working_directory: agentCwd,
      repo_root: git.repoRoot,
      worktree_path: worktreePath,
      branch,
      base_commit: git.baseCommit,
      target_commit: this.git(git.repoRoot, ["rev-parse", "HEAD"]).trim(),
      artifacts_dir: artifactsDir,
      status_path: path.join(artifactsDir, "status.txt"),
      patch_path: patchPath,
      metadata_path: path.join(artifactsDir, "workspace.json"),
      status_command: `git -C ${quoteShell(worktreePath)} status --short`,
      diff_command: `git -C ${quoteShell(worktreePath)} diff ${git.baseCommit} --`,
      apply_command: `git -C ${quoteShell(git.repoRoot)} apply ${quoteShell(
        patchPath,
      )}`,
      merge_command: `git -C ${quoteShell(git.repoRoot)} merge --no-ff ${quoteShell(
        branch,
      )}`,
    };
  }

  private messageForAgent(task: string, workspace: RunWorkspace): string {
    if (workspace.mode !== "worktree") return task;
    return `${task}

Bridge workspace note: you are running in an isolated git worktree at ${workspace.agent_working_directory}. Make code changes in files. In your final answer, summarize the work and tests only; do not paste full diffs or patches. The coordinator will inspect changes with git using the branch, worktree, and patch artifacts returned by the bridge.`;
  }

  private finalizeWorkspace(runId: string): RunWorkspace | undefined {
    const record = this.options.store.getRun(runId);
    const workspace = record?.workspace;
    if (
      !workspace ||
      workspace.mode !== "worktree" ||
      !workspace.worktree_path
    ) {
      return workspace;
    }

    const finalized: RunWorkspace = { ...workspace };
    try {
      const status = this.git(workspace.worktree_path, [
        "status",
        "--porcelain=v1",
      ]);
      finalized.has_changes = status.trim().length > 0;
      finalized.untracked_files = parseUntrackedFiles(status);
      if (workspace.status_path) {
        fs.writeFileSync(workspace.status_path, status, "utf8");
      }
      if (status.trim()) {
        this.git(workspace.worktree_path, ["add", "-N", "."]);
      }
      if (workspace.patch_path && workspace.base_commit) {
        const patch = this.git(workspace.worktree_path, [
          "diff",
          "--binary",
          workspace.base_commit,
          "--",
        ]);
        fs.writeFileSync(workspace.patch_path, patch, "utf8");
      }
      if (workspace.base_commit) {
        finalized.changed_files = this.git(workspace.worktree_path, [
          "diff",
          "--name-only",
          workspace.base_commit,
          "--",
        ])
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean);
      }
      if (workspace.repo_root) {
        finalized.target_commit = this.git(workspace.repo_root, [
          "rev-parse",
          "HEAD",
        ]).trim();
      }
      if (workspace.metadata_path) {
        fs.writeFileSync(
          workspace.metadata_path,
          JSON.stringify(finalized, null, 2),
          "utf8",
        );
      }
      this.options.store.updateRunWorkspace(runId, finalized);
      return finalized;
    } catch (error) {
      finalized.setup_error =
        error instanceof Error ? error.message : String(error);
      this.options.store.updateRunWorkspace(runId, finalized);
      return finalized;
    }
  }

  private gitContext(
    cwd: string,
  ): { repoRoot: string; baseCommit: string } | undefined {
    try {
      const repoRoot = this.git(cwd, ["rev-parse", "--show-toplevel"]).trim();
      const inside = this.git(cwd, [
        "rev-parse",
        "--is-inside-work-tree",
      ]).trim();
      if (inside !== "true") return undefined;
      const baseCommit = this.git(repoRoot, ["rev-parse", "HEAD"]).trim();
      return { repoRoot, baseCommit };
    } catch {
      return undefined;
    }
  }

  private git(cwd: string, args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  private clientFor(run: ActiveRun): PiRpcClient {
    return (run as ActiveRun & { client: PiRpcClient }).client;
  }

  private argsFor(input: StartRunInput): string[] | undefined {
    const args = [...(this.options.piArgs ?? [])];
    if (input.session_id) {
      args.push(this.options.sessionIdFlag ?? "--session-id", input.session_id);
    } else if (this.options.noSessionFlag) {
      args.push(this.options.noSessionFlag);
    }
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

  private captureSessionId(runId: string, data: unknown): void {
    const sid = extractSessionId(data) ?? this.inferSessionId(runId);
    if (!sid) return;
    const run = this.active.get(runId);
    if (!run) return;
    (run as ActiveRun & { sessionId?: string }).sessionId = sid;
    this.options.store.updateRunSessionId(runId, sid);
  }

  private getRunSessionId(runId: string): string | undefined {
    const run = this.active.get(runId);
    const sid =
      (run as (ActiveRun & { sessionId?: string }) | undefined)?.sessionId ??
      undefined;
    if (sid) return sid;
    const inferred = this.inferSessionId(runId);
    if (inferred) return inferred;
    return this.options.store.getRun(runId)?.session_id;
  }

  private inferSessionId(runId: string): string | undefined {
    const run = this.active.get(runId);
    if (!run) return undefined;
    const record = this.options.store.getRun(runId);
    if (!record || record.session_id) return record?.session_id;
    const snapshot =
      (run as ActiveRun & { sessionSnapshot?: Map<string, number> })
        .sessionSnapshot ?? new Map<string, number>();
    const inferred = newestCreatedSessionId(
      this.sessionDirsFor(
        record.workspace?.agent_working_directory ?? record.working_directory,
      ),
      snapshot,
      run.startedAtMs,
    );
    if (!inferred) return undefined;
    (run as ActiveRun & { sessionId?: string }).sessionId = inferred;
    this.options.store.updateRunSessionId(runId, inferred);
    return inferred;
  }

  private sessionDirsFor(cwd: string): string[] {
    const root =
      this.options.piSessionDir ??
      process.env.PI_CODING_AGENT_SESSION_DIR ??
      path.join(
        process.env.PI_CODING_AGENT_DIR ??
          path.join(process.env.HOME ?? "", ".pi", "agent"),
        "sessions",
      );
    const projectKey = sessionProjectKey(cwd);
    return [path.join(root, projectKey), root];
  }

  private killRun(run: ActiveRun, signal: NodeJS.Signals): void {
    this.clientFor(run).terminate(signal);
  }

  private sendAbort(run: ActiveRun): boolean {
    return this.clientFor(run).send(this.options.abortMethod, {
      run_id: run.run_id,
    });
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

function extractSessionId(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const sid = data.session_id ?? data.sessionId ?? data.session ?? undefined;
  return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}

function sessionProjectKey(cwd: string): string {
  const normalized = path
    .resolve(cwd)
    .split(path.sep)
    .filter(Boolean)
    .join("-");
  return `--${normalized}--`;
}

function snapshotSessionFiles(dirs: string[]): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const dir of dirs) {
    for (const file of sessionFiles(dir)) {
      snapshot.set(file.path, file.mtimeMs);
    }
  }
  return snapshot;
}

function newestCreatedSessionId(
  dirs: string[],
  snapshot: Map<string, number>,
  startedAtMs: number,
): string | undefined {
  let best: { sessionId: string; mtimeMs: number } | undefined;
  for (const dir of dirs) {
    for (const file of sessionFiles(dir)) {
      const previousMtime = snapshot.get(file.path);
      if (previousMtime !== undefined && previousMtime === file.mtimeMs) {
        continue;
      }
      if (file.mtimeMs < startedAtMs - 1000) continue;
      const sessionId = sessionIdFromPath(file.path);
      if (!sessionId) continue;
      if (!best || file.mtimeMs > best.mtimeMs) {
        best = { sessionId, mtimeMs: file.mtimeMs };
      }
    }
  }
  return best?.sessionId;
}

function sessionFiles(dir: string): Array<{ path: string; mtimeMs: number }> {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => {
        const filePath = path.join(dir, entry.name);
        return { path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
      });
  } catch {
    return [];
  }
}

function sessionIdFromPath(filePath: string): string | undefined {
  const match =
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(
      path.basename(filePath),
    );
  return match?.[1];
}

function parseUntrackedFiles(status: string): string[] {
  return status
    .split("\n")
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
