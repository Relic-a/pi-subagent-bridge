import fs from "node:fs";
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
    maxConcurrentRuns: 2,
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
    delete process.env.FAKE_PI_SESSION_DIR;
    delete process.env.FAKE_PI_SUPPRESS_SESSION_RPC;
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

  it("interrupted wait does not stop the agent", async () => {
    const { run_id } = await manager.start({
      task: "interrupted wait",
      working_directory: tmp,
    });
    void manager.wait(run_id);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(manager.readResult(run_id).state).toBe("completed");
  });

  it("duplicate stop calls are idempotent", async () => {
    const { run_id } = await manager.start({
      task: "never stop",
      working_directory: tmp,
    });
    await Promise.all([manager.stop(run_id), manager.stop(run_id)]);
    const result = await manager.wait(run_id);
    expect(result.state).toBe("stopped");
  });

  it("stop escalates after abort grace when Pi ignores abort", async () => {
    process.env.FAKE_PI_IGNORE_ABORT = "1";
    const abortFile = path.join(tmp, "abort.log");
    process.env.FAKE_PI_ABORT_FILE = abortFile;
    const { run_id } = await manager.start({
      task: "never ignore abort",
      working_directory: tmp,
    });
    await manager.stop(run_id);
    const result = await manager.wait(run_id);
    expect(result.state).toBe("stopped");
    expect(fs.readFileSync(abortFile, "utf8")).toContain("abort");
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

  it("concurrency and timeout limits work", async () => {
    await manager.shutdown();
    store = new ToolCallStore(path.join(tmp, "state2.sqlite"));
    manager = new RunManager({
      store,
      piExecutable: "python3",
      piArgs: [fakePi],
      allowedRoots: [tmp],
      maxConcurrentRuns: 1,
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
    await expect(
      manager.start({ task: "never two", working_directory: tmp }),
    ).rejects.toThrow(/Concurrency/);
    await expect(manager.wait(first.run_id)).resolves.toHaveProperty(
      "state",
      "timed_out",
    );
  });

  it("exposes session_id in diagnostics and results when run without explicit session", async () => {
    const started = await manager.start({
      task: "session test",
      working_directory: tmp,
    });
    // Wait for the prompt request to resolve so session_id is captured
    await new Promise((resolve) => setTimeout(resolve, 50));
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
