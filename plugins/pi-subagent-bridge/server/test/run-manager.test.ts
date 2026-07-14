import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunManager } from "../src/run-manager.js";
import { ToolCallStore } from "../src/tool-call-store.js";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.py", import.meta.url));
let tmp: string;
let store: ToolCallStore;
let manager: RunManager;

function execGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

async function waitForReadableResult(runId: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return manager.readResult(runId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw lastError;
}

async function waitForFile(filePath: string, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForFileContent(
  filePath: string,
  expected: string,
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      fs.existsSync(filePath) &&
      fs.readFileSync(filePath, "utf8").includes(expected)
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${expected} in ${filePath}`);
}

async function waitForRunState(
  runId: string,
  expected: "running" | "completed",
  timeoutMs = 1000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (manager.getRun(runId).state === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for run ${runId} to become ${expected}`);
}

function makeManager(
  extraEnv?: NodeJS.ProcessEnv,
  overrides?: Partial<ConstructorParameters<typeof RunManager>[0]>,
) {
  store = new ToolCallStore(path.join(tmp, "state.sqlite"));
  manager = new RunManager({
    store,
    piExecutable: "python3",
    piArgs: [fakePi],
    allowedRoots: [tmp],
    maxRuntimeMs: 1000,
    stopGraceMs: 50,
    startMethod: "prompt",
    abortMethod: "abort",
    sessionIdFlag: "--session-id",
    ...overrides,
  });
  if (extraEnv) Object.assign(process.env, extraEnv);
  return manager;
}

describe("RunManager", () => {
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-"));
    makeManager();
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => undefined);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.FAKE_PI_IGNORE_ABORT;
    delete process.env.FAKE_PI_ABORT_FILE;
    delete process.env.FAKE_PI_ARGS_FILE;
    delete process.env.FAKE_PI_PROMPT_FILE;
    delete process.env.FAKE_PI_PROMPT_REQUEST_FILE;
    delete process.env.FAKE_PI_SIGNAL_FILE;
    delete process.env.FAKE_PI_SESSION_DIR;
    delete process.env.FAKE_PI_SUPPRESS_SESSION_RPC;
    delete process.env.FAKE_PI_IGNORE_SIGTERM;
    delete process.env.FAKE_PI_PID_FILE;
    delete process.env.FAKE_PI_EXIT_ON_PROMPT;
    delete process.env.FAKE_PI_DELAY_MS;
    delete process.env.FAKE_PI_END_BEFORE_STEER_RESPONSE;
  });

  it("returns from start before fake agent completes and wait resolves on agent_end", async () => {
    const started = await manager.start({
      task: "finish later",
      working_directory: tmp,
    });
    const diag = manager.getRun(started.run_id);
    expect(["starting", "running"]).toContain(diag.state);
    const result = await manager.wait(started.run_id);
    expect(result).toMatchObject({
      state: "completed",
      final_answer: "fake final answer",
    });
  });

  it("multiple waiters share the same result without corrupting state", async () => {
    const { run_id } = await manager.start({
      task: "multi waiter",
      working_directory: tmp,
    });
    const results = await Promise.all([
      manager.wait(run_id),
      manager.wait(run_id),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(manager.getRun(run_id).state).toBe("completed");
  });

  it("enforces the configured concurrent run limit", async () => {
    await manager.shutdown();
    makeManager(undefined, { maxConcurrentRuns: 1 });
    const first = await manager.start({
      task: "never occupy slot",
      working_directory: tmp,
      workspace_mode: "direct",
    });
    await expect(
      manager.start({ task: "second", working_directory: tmp }),
    ).rejects.toThrow(/RUN_CONCURRENCY_LIMIT/);
    await manager.stop(first.run_id);
    await manager.wait(first.run_id);
  });

  it("interrupted wait does not stop the agent", async () => {
    const { run_id } = await manager.start({
      task: "interrupted wait",
      working_directory: tmp,
    });
    void manager.wait(run_id);
    expect((await waitForReadableResult(run_id)).state).toBe("completed");
  });

  it("duplicate stop calls are idempotent", async () => {
    await manager.shutdown();
    makeManager(undefined, { stopGraceMs: 500 });
    const { run_id } = await manager.start({
      task: "never stop",
      working_directory: tmp,
    });
    const startedAt = Date.now();
    await Promise.all([manager.stop(run_id), manager.stop(run_id)]);
    const result = await manager.wait(run_id);
    expect(result.state).toBe("stopped");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("stop escalates after abort grace when Pi ignores abort", async () => {
    await manager.shutdown();
    makeManager(undefined, { stopGraceMs: 100 });
    process.env.FAKE_PI_IGNORE_ABORT = "1";
    const abortFile = path.join(tmp, "abort.log");
    const signalFile = path.join(tmp, "signals.log");
    const pidFile = path.join(tmp, "pi.pid");
    process.env.FAKE_PI_ABORT_FILE = abortFile;
    process.env.FAKE_PI_SIGNAL_FILE = signalFile;
    process.env.FAKE_PI_PID_FILE = pidFile;
    const { run_id } = await manager.start({
      task: "never ignore abort",
      working_directory: tmp,
    });
    await waitForFile(pidFile);
    const startedAt = Date.now();
    await manager.stop(run_id);
    const result = await manager.wait(run_id);
    expect(result.state).toBe("stopped");
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    await waitForFileContent(abortFile, "abort");
    await waitForFileContent(signalFile, "SIGTERM");
  });

  it("server shutdown resolves active children as stopped", async () => {
    const { run_id } = await manager.start({
      task: "never shutdown",
      working_directory: tmp,
    });
    const wait = manager.wait(run_id);
    await manager.shutdown();
    await expect(wait).resolves.toHaveProperty("state", "stopped");
  });

  it("records bounded run events and exposes a coordinator snapshot", async () => {
    const { run_id } = await manager.start({
      task: "audit",
      working_directory: tmp,
    });
    await manager.wait(run_id);
    const events = manager.getRunEvents(run_id);
    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(["run_state", "tool_started", "terminal"]),
    );
    expect(JSON.stringify(events)).not.toContain("SECRET OUTPUT");
    const snapshot = manager.getRunSnapshot(run_id);
    expect(snapshot).toMatchObject({ run_id, state: "completed" });
    expect(snapshot.tool_calls_count).toBe(1);
    expect(snapshot.event_cursor).toBeGreaterThan(0);
  });

  it("steers an active run through its live RPC client and records acknowledgement", async () => {
    process.env.FAKE_PI_DELAY_MS = "500";
    const promptFile = path.join(tmp, "prompt.txt");
    const promptRequestFile = path.join(tmp, "prompt-requests.jsonl");
    process.env.FAKE_PI_PROMPT_FILE = promptFile;
    process.env.FAKE_PI_PROMPT_REQUEST_FILE = promptRequestFile;
    const { run_id } = await manager.start({
      task: "finish later",
      working_directory: tmp,
    });
    await waitForRunState(run_id, "running");
    const response = await manager.steer(
      run_id,
      "Run focused tests before finishing.",
    );
    expect(response).toMatchObject({ run_id, delivery: "acknowledged" });
    expect(fs.readFileSync(promptFile, "utf8")).toContain(
      "Coordinator steering",
    );
    const promptRequests = fs
      .readFileSync(promptRequestFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(promptRequests.at(-1)).toMatchObject({
      type: "prompt",
      streamingBehavior: "steer",
    });
    expect(manager.getRunEvents(run_id).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["steer_sent", "steer_acknowledged"]),
    );
    await manager.stop(run_id);
  });

  it("does not acknowledge a steer after the run becomes terminal", async () => {
    process.env.FAKE_PI_END_BEFORE_STEER_RESPONSE = "1";
    const { run_id } = await manager.start({
      task: "never finish without steering",
      working_directory: tmp,
    });
    await waitForRunState(run_id, "running");

    await expect(manager.steer(run_id, "finish now")).rejects.toThrow(
      "RUN_NOT_ACTIVE_AFTER_STEER",
    );
    await expect(manager.wait(run_id)).resolves.toHaveProperty(
      "state",
      "completed",
    );
    expect(manager.getRunEvents(run_id).map((event) => event.kind)).toEqual(
      expect.arrayContaining(["steer_sent", "steer_failed", "terminal"]),
    );
    expect(
      manager.getRunEvents(run_id).map((event) => event.kind),
    ).not.toContain("steer_acknowledged");
  });

  it("rejects steering a completed run", async () => {
    const { run_id } = await manager.start({
      task: "finish later",
      working_directory: tmp,
    });
    await manager.wait(run_id);
    await expect(manager.steer(run_id, "too late")).rejects.toThrow(
      "RUN_NOT_ACTIVE",
    );
  });

  it("tool starts are timestamped, ordered, sanitized, and results are not persisted", async () => {
    const { run_id } = await manager.start({
      task: "audit",
      working_directory: tmp,
    });
    await manager.wait(run_id);
    const calls = manager.recentToolCalls(10, run_id);
    expect(calls).toHaveLength(1);
    expect(calls[0].sequence).toBeGreaterThan(0);
    expect(calls[0].timestamp).toMatch(/Z$/);
    expect(JSON.stringify(calls[0])).toContain("[REDACTED]");
    expect(JSON.stringify(calls[0])).not.toContain("SECRET OUTPUT");
  });

  it("child crash transitions the run to failed", async () => {
    const { run_id } = await manager.start({
      task: "please crash",
      working_directory: tmp,
    });
    const result = await manager.wait(run_id);
    expect(result.state).toBe("failed");
  });

  it("includes Pi stderr when a startup crash fails the run", async () => {
    process.env.FAKE_PI_EXIT_ON_PROMPT = "1";
    const { run_id } = await manager.start({
      task: "show startup diagnostics",
      working_directory: tmp,
    });

    await expect(manager.wait(run_id)).resolves.toMatchObject({
      state: "failed",
      error: expect.stringMatching(/stderr: intentional Pi prompt failure/),
    });
  });

  it("timeout limit works", async () => {
    await manager.shutdown();
    store = new ToolCallStore(path.join(tmp, "state2.sqlite"));
    manager = new RunManager({
      store,
      piExecutable: "python3",
      piArgs: [fakePi],
      allowedRoots: [tmp],
      maxRuntimeMs: 80,
      stopGraceMs: 20,
      startMethod: "prompt",
      abortMethod: "abort",
      sessionIdFlag: "--session-id",
    });
    const first = await manager.start({
      task: "never one",
      working_directory: tmp,
    });
    await expect(manager.wait(first.run_id)).resolves.toHaveProperty(
      "state",
      "timed_out",
    );
  });

  it("timeout escalates to SIGKILL and does not orphan the process group", async () => {
    await manager.shutdown();
    const pidFile = path.join(tmp, "pi.pid");
    process.env.FAKE_PI_PID_FILE = pidFile;
    process.env.FAKE_PI_IGNORE_SIGTERM = "1";
    process.env.FAKE_PI_IGNORE_ABORT = "1";
    makeManager(undefined, { maxRuntimeMs: 500, killGraceMs: 40 });
    const { run_id } = await manager.start({
      task: "never survive timeout",
      working_directory: tmp,
      workspace_mode: "direct",
    });
    await expect(manager.wait(run_id)).resolves.toHaveProperty(
      "state",
      "timed_out",
    );
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it("exposes session_id in diagnostics and results when run without explicit session", async () => {
    const started = await manager.start({
      task: "session test",
      working_directory: tmp,
    });
    const deadline = Date.now() + 1000;
    while (
      !manager.getRun(started.run_id).session_id &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const diag = manager.getRun(started.run_id);
    expect(diag.session_id).toBeDefined();
    expect(typeof diag.session_id).toBe("string");
    const result = await manager.wait(started.run_id);
    expect(result.session_id).toBe(diag.session_id);
    expect(result.session_id?.startsWith("session-")).toBe(true);
  });

  it("infers Pi's real session_id from the session file when RPC omits it", async () => {
    const sessionDir = path.join(tmp, "sessions");
    process.env.FAKE_PI_SESSION_DIR = sessionDir;
    process.env.FAKE_PI_SUPPRESS_SESSION_RPC = "1";
    await manager.shutdown();
    makeManager(undefined, { piSessionDir: sessionDir });

    const started = await manager.start({
      task: "session file only",
      working_directory: tmp,
    });

    const result = await manager.wait(started.run_id);
    expect(result.session_id).toBe("019ebd7c-ff7f-7d72-a11d-81e5d8d4d87c");
    expect(manager.getRun(started.run_id).session_id).toBe(result.session_id);
    expect(manager.readResult(started.run_id).session_id).toBe(
      result.session_id,
    );
  });

  it("starts new runs without disabling Pi session persistence", async () => {
    const argsFile = path.join(tmp, "args.jsonl");
    process.env.FAKE_PI_ARGS_FILE = argsFile;
    const { run_id } = await manager.start({
      task: "new persisted session",
      working_directory: tmp,
    });
    await manager.wait(run_id);

    const [args] = fs
      .readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(args).not.toContain("--no-session");
    expect(args).not.toContain("--session-id");
  });

  it("isolates git-backed runs in worktrees and returns compact change references", async () => {
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "base\n");
    execGit(tmp, ["init"]);
    execGit(tmp, ["add", "tracked.txt"]);
    execGit(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "base",
    ]);

    const started = await manager.start({
      task: "write workspace files",
      working_directory: tmp,
    });
    expect(started.workspace.mode).toBe("worktree");
    expect(started.workspace.agent_working_directory).not.toBe(tmp);

    const result = await manager.wait(started.run_id);

    expect(fs.readFileSync(path.join(tmp, "tracked.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(fs.existsSync(path.join(tmp, "new-file.txt"))).toBe(false);
    expect(result.workspace?.mode).toBe("worktree");
    expect(result.workspace?.has_changes).toBe(true);
    expect(result.workspace?.changed_files).toEqual(
      expect.arrayContaining(["tracked.txt", "new-file.txt"]),
    );
    expect(result.workspace?.untracked_files).toEqual(["new-file.txt"]);
    const snapshot = manager.getRunSnapshot(started.run_id);
    expect(snapshot.phase).toBe("terminal");
    expect(snapshot.total_changed_files).toBe(2);
    expect(snapshot.changed_files.map((file) => file.path)).not.toContain(
      ".pi-bridge/status.txt",
    );
    expect(JSON.stringify(snapshot.recent_progress)).not.toContain(
      "synthetic-test-value",
    );
    expect(result.workspace?.patch_path).toBeDefined();
    expect(result.workspace?.diff_command).toContain("git -C");
    expect(result.workspace?.diff_command).not.toContain("pi edit");
    expect(fs.readFileSync(result.workspace!.status_path!, "utf8")).toContain(
      "tracked.txt",
    );
    expect(fs.readFileSync(result.workspace!.patch_path!, "utf8")).toContain(
      "pi edit",
    );
  });

  it("snapshots dirty tracked and untracked coordinator files without returning them as Pi changes", async () => {
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "base\n");
    execGit(tmp, ["init"]);
    execGit(tmp, ["add", "tracked.txt"]);
    execGit(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "base",
    ]);
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "coordinator edit\n");
    fs.writeFileSync(path.join(tmp, "context.txt"), "untracked context\n");

    const started = await manager.start({
      task: "write workspace files",
      working_directory: tmp,
    });
    expect(started.workspace.snapshot_applied).toBe(true);
    expect(
      fs.readFileSync(
        path.join(started.workspace.agent_working_directory, "context.txt"),
        "utf8",
      ),
    ).toBe("untracked context\n");
    const result = await manager.wait(started.run_id);

    expect(result.workspace?.source_base_commit).toBeDefined();
    expect(result.workspace?.base_commit).not.toBe(
      result.workspace?.source_base_commit,
    );
    expect(result.workspace?.diff_command).toContain(
      result.workspace!.base_commit!,
    );
    expect(result.workspace?.diff_command).not.toContain(
      result.workspace!.source_base_commit!,
    );
    expect(result.workspace?.changed_files).not.toContain("context.txt");
    expect(fs.readFileSync(path.join(tmp, "tracked.txt"), "utf8")).toBe(
      "coordinator edit\n",
    );
  });

  it("checks and applies an isolated run patch, then discards its worktree", async () => {
    fs.writeFileSync(path.join(tmp, "tracked.txt"), "base\n");
    execGit(tmp, ["init"]);
    execGit(tmp, ["add", "tracked.txt"]);
    execGit(tmp, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "base",
    ]);
    const started = await manager.start({
      task: "write workspace files",
      working_directory: tmp,
    });
    await manager.wait(started.run_id);

    expect(manager.applyChanges(started.run_id, true)).toMatchObject({
      applied: false,
    });
    expect(fs.readFileSync(path.join(tmp, "tracked.txt"), "utf8")).toBe(
      "base\n",
    );
    expect(manager.applyChanges(started.run_id)).toMatchObject({
      applied: true,
    });
    expect(fs.readFileSync(path.join(tmp, "tracked.txt"), "utf8")).toContain(
      "pi edit",
    );
    expect(manager.discardWorkspace(started.run_id)).toEqual({
      run_id: started.run_id,
      discarded: true,
    });
    expect(fs.existsSync(started.workspace.worktree_path!)).toBe(false);
  });

  it("wraps tasks with coordinator instructions before prompting Pi", async () => {
    const promptFile = path.join(tmp, "prompt.txt");
    process.env.FAKE_PI_PROMPT_FILE = promptFile;

    const { run_id } = await manager.start({
      task: "implement the requested change",
      working_directory: tmp,
      workspace_mode: "direct",
    });
    await manager.wait(run_id);

    const prompt = fs.readFileSync(promptFile, "utf8");
    expect(prompt).toContain(
      "You are a coding subagent working for a coordinator.",
    );
    expect(prompt).toContain(
      "Treat the user task below as the authoritative request.",
    );
    expect(prompt).toContain("Preserve unrelated user or repository changes.");
    expect(prompt).toContain("Run the most relevant verification available");
    expect(prompt).toContain("User task:\nimplement the requested change");
  });

  it("accepts and returns an explicit session_id", async () => {
    const started = await manager.start({
      task: "explicit session",
      working_directory: tmp,
      session_id: "my-custom-session",
    });
    const result = await manager.wait(started.run_id);
    expect(result.session_id).toBe("my-custom-session");
    const diag = manager.getRun(started.run_id);
    expect(diag.session_id).toBe("my-custom-session");
    expect(manager.readResult(started.run_id).session_id).toBe(
      "my-custom-session",
    );
  });

  it("continues explicit sessions with Pi's exact session-id flag", async () => {
    const argsFile = path.join(tmp, "resume-args.jsonl");
    process.env.FAKE_PI_ARGS_FILE = argsFile;
    const { run_id } = await manager.start({
      task: "explicit session args",
      working_directory: tmp,
      session_id: "my-custom-session",
    });
    await manager.wait(run_id);

    const [args] = fs
      .readFileSync(argsFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(args).toContain("--session-id");
    expect(args).toContain("my-custom-session");
    expect(args).not.toContain("--no-session");
  });

  it("rejects invalid working directories and path traversal", async () => {
    await expect(
      manager.start({ task: "x", working_directory: `${tmp}/../elsewhere` }),
    ).rejects.toThrow(/traversal/);
    await expect(
      manager.start({ task: "x", working_directory: "/does/not/exist" }),
    ).rejects.toThrow(/allowed root/);
  });
});
