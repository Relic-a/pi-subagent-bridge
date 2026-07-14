import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PiRpcClient } from "./pi-rpc-client.js";
import { redactSecrets } from "./redaction.js";
const TERMINAL_STATES = new Set([
    "completed",
    "failed",
    "stopped",
    "timed_out",
]);
const ALLOWED_TRANSITIONS = {
    starting: [
        "running",
        "completed",
        "failed",
        "stopping",
        "stopped",
        "timed_out",
    ],
    running: ["completed", "failed", "stopping", "timed_out"],
    completed: [],
    failed: [],
    stopping: ["stopped", "failed", "timed_out"],
    stopped: [],
    timed_out: [],
};
export class RunManager {
    options;
    active = new Map();
    shuttingDown = false;
    constructor(options) {
        this.options = options;
    }
    async start(input) {
        const maxConcurrentRuns = this.options.maxConcurrentRuns ?? 4;
        if (this.active.size >= maxConcurrentRuns) {
            throw new Error(`RUN_CONCURRENCY_LIMIT: maximum ${maxConcurrentRuns} active runs`);
        }
        const cwd = this.validateWorkingDirectory(input.working_directory);
        const runId = crypto.randomUUID();
        const workspace = this.prepareWorkspace(cwd, runId, input.workspace_mode);
        const agentCwd = workspace.agent_working_directory;
        const now = new Date().toISOString();
        let resolveOnce;
        const waitPromise = new Promise((resolve) => {
            let resolved = false;
            resolveOnce = (result) => {
                if (resolved)
                    return;
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
            env: this.options.piEnv,
            onEvent: (event) => this.handleEvent(runId, event),
            onExit: (code, signal, error) => this.handleExit(runId, code, signal, error),
            onMalformedLine: (line) => {
                this.failRun(runId, `Malformed Pi JSONL output: ${line.slice(0, 160)}`);
            },
            requestTimeoutMs: Number.parseInt(process.env.PI_RPC_REQUEST_TIMEOUT_MS ?? "120000", 10),
            ignoreNonJsonNoise: process.env.PI_RPC_IGNORE_NON_JSON_NOISE === "1",
        });
        const run = {
            run_id: runId,
            child: client.child,
            state: "starting",
            startedAtMs: Date.now(),
            waitPromise,
            resolveOnce,
            stopRequested: false,
            abortSent: false,
            client,
            sessionId,
            sessionSnapshot,
            settled: false,
        };
        this.active.set(runId, run);
        let pruned;
        try {
            pruned = this.options.store.createRun({
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
            }, this.active.keys());
        }
        catch (error) {
            this.killRun(run, "SIGKILL");
            this.active.delete(runId);
            this.removeWorkspace(workspace);
            throw error;
        }
        for (const record of pruned)
            this.removeWorkspace(record.workspace);
        this.emitProgress(runId, "starting");
        run.timeoutTimer = setTimeout(() => {
            this.finalizeOnce(runId, "timed_out", "", "Maximum runtime exceeded.");
        }, this.options.maxRuntimeMs);
        client
            .request(this.options.startMethod, {
            message: this.messageForAgent(input.task, workspace),
        })
            .then((data) => {
            const active = this.active.get(runId);
            if (!active || active.settled || active.state !== "starting")
                return;
            this.captureSessionId(runId, data);
            this.transition(runId, "running", undefined, true);
            this.emitProgress(runId, "running");
        })
            .catch((error) => {
            const active = this.active.get(runId);
            if (active?.state === "stopping")
                return;
            this.failRun(runId, `Pi start failed: ${error.message}`);
        });
        return { run_id: runId, session_id: sessionId, workspace };
    }
    wait(runId, timeoutMs) {
        const active = this.active.get(runId);
        if (active) {
            if (timeoutMs && timeoutMs > 0) {
                return this.waitWithProgress(active, timeoutMs);
            }
            return active.waitPromise;
        }
        const record = this.options.store.getRun(runId);
        if (!record)
            throw new Error(`Unknown run_id: ${runId}`);
        if (!TERMINAL_STATES.has(record.state))
            throw new Error(`Run ${runId} is not active but is ${record.state}.`);
        return Promise.resolve({
            run_id: runId,
            state: record.state,
            final_answer: record.final_answer ?? "",
            error: record.error,
            session_id: record.session_id,
            workspace: record.workspace,
        });
    }
    async waitWithProgress(active, timeoutMs) {
        const runId = active.run_id;
        let progressTimer;
        try {
            const result = await Promise.race([
                active.waitPromise,
                new Promise((resolve) => {
                    progressTimer = setTimeout(() => {
                        progressTimer = undefined;
                        const toolCallsCount = this.options.store.countToolCalls(runId);
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
        }
        finally {
            if (progressTimer)
                clearTimeout(progressTimer);
        }
    }
    async stop(runId) {
        const active = this.active.get(runId);
        if (!active)
            return this.getRun(runId);
        if (TERMINAL_STATES.has(active.state))
            return this.getRun(runId);
        if (!active.stopRequested) {
            active.stopRequested = true;
            this.transition(runId, "stopping", undefined, true);
            active.abortSent = this.sendAbort(active);
            active.forceTimer = setTimeout(() => {
                this.finalizeOnce(runId, "stopped", "");
            }, this.options.stopGraceMs);
        }
        return this.getRun(runId);
    }
    getRun(runId) {
        const record = this.options.store.getRun(runId);
        if (!record)
            throw new Error(`Unknown run_id: ${runId}`);
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
    readResult(runId) {
        const record = this.options.store.getRun(runId);
        if (!record)
            throw new Error(`Unknown run_id: ${runId}`);
        if (!TERMINAL_STATES.has(record.state))
            throw new Error(`Run ${runId} has not completed.`);
        return {
            run_id: runId,
            state: record.state,
            final_answer: record.final_answer ?? "",
            error: record.error,
            session_id: record.session_id,
            workspace: record.workspace,
        };
    }
    recentToolCalls(limit, runId) {
        return this.options.store.recentToolCalls(limit, runId);
    }
    getRunEvents(runId, after, limit) {
        if (!this.options.store.getRun(runId))
            throw new Error(`Unknown run_id: ${runId}`);
        return this.options.store.getRunEvents(runId, after, limit);
    }
    getRunSnapshot(runId) {
        const record = this.options.store.getRun(runId);
        if (!record)
            throw new Error(`Unknown run_id: ${runId}`);
        const active = this.active.get(runId);
        const events = this.options.store.latestRunEvents(runId, 8);
        const changedFiles = this.workspaceSummary(record.workspace);
        const latest = events.at(-1);
        return {
            run_id: runId,
            state: record.state,
            phase: phaseFromEvents(events, record.state),
            elapsed_ms: active
                ? Date.now() - active.startedAtMs
                : Date.parse(record.updated_at) - Date.parse(record.created_at),
            last_activity_at: latest?.timestamp ?? record.updated_at,
            latest_activity: latest ? eventSummary(latest) : undefined,
            tool_calls_count: this.options.store.countToolCalls(runId),
            changed_files: changedFiles.slice(0, 12),
            total_changed_files: changedFiles.length,
            recent_progress: events.slice(-6).map(eventSummary),
            event_cursor: this.options.store.latestRunEventSequence(runId),
        };
    }
    async steer(runId, message) {
        const active = this.active.get(runId);
        if (!active ||
            active.settled ||
            TERMINAL_STATES.has(active.state) ||
            active.state === "stopping")
            throw new Error("RUN_NOT_ACTIVE");
        const text = message.trim();
        if (!text)
            throw new Error("STEER_MESSAGE_EMPTY");
        if (text.length > 4000)
            throw new Error("STEER_MESSAGE_TOO_LONG");
        const sent = this.options.store.addRunEvent({
            timestamp: new Date().toISOString(),
            run_id: runId,
            kind: "steer_sent",
            payload: { summary: String(redactSecrets(text)).slice(0, 500) },
        });
        try {
            await active.client.request(this.options.steerMethod ?? this.options.startMethod, {
                message: `Coordinator steering (follow this in addition to the original task):\n${text}`,
            });
            const acknowledged = this.options.store.addRunEvent({
                timestamp: new Date().toISOString(),
                run_id: runId,
                kind: "steer_acknowledged",
                payload: { sent_sequence: sent.sequence },
            });
            return {
                run_id: runId,
                delivery: "acknowledged",
                steer_event: acknowledged.sequence,
            };
        }
        catch (error) {
            this.options.store.addRunEvent({
                timestamp: new Date().toISOString(),
                run_id: runId,
                kind: "steer_failed",
                payload: {
                    sent_sequence: sent.sequence,
                    error: String(redactSecrets(error instanceof Error ? error.message : String(error))).slice(0, 500),
                },
            });
            throw error;
        }
    }
    applyChanges(runId, dryRun = false) {
        const result = this.readResult(runId);
        const workspace = result.workspace;
        if (!workspace?.repo_root || !workspace.patch_path)
            throw new Error("RUN_HAS_NO_ISOLATED_CHANGES");
        const current = this.git(workspace.repo_root, ["rev-parse", "HEAD"]).trim();
        if (workspace.target_commit && current !== workspace.target_commit)
            throw new Error("TARGET_REVISION_CHANGED");
        const worktreeRoot = workspace.worktree_path
            ? path
                .relative(workspace.repo_root, workspace.worktree_path)
                .split(path.sep)[0]
            : undefined;
        const statusArgs = [
            "status",
            "--porcelain",
            "--untracked-files=no",
            "--",
            ".",
        ];
        if (worktreeRoot)
            statusArgs.push(`:(exclude)${worktreeRoot}`);
        if (this.git(workspace.repo_root, statusArgs).trim())
            throw new Error("TARGET_WORKTREE_DIRTY");
        this.git(workspace.repo_root, [
            "apply",
            "--check",
            "--binary",
            workspace.patch_path,
        ]);
        if (dryRun) {
            return {
                run_id: runId,
                applied: false,
                changed_files: workspace.changed_files ?? [],
            };
        }
        this.git(workspace.repo_root, ["apply", "--binary", workspace.patch_path]);
        if (process.env.PI_BRIDGE_AUTO_DISCARD_AFTER_APPLY === "1") {
            this.discardWorkspace(runId);
        }
        return {
            run_id: runId,
            applied: true,
            changed_files: workspace.changed_files ?? [],
        };
    }
    discardWorkspace(runId) {
        const workspace = this.getRun(runId).workspace;
        if (!workspace?.repo_root || !workspace.worktree_path)
            throw new Error("RUN_HAS_NO_ISOLATED_WORKSPACE");
        this.git(workspace.repo_root, [
            "worktree",
            "remove",
            "--force",
            workspace.worktree_path,
        ]);
        if (workspace.branch)
            this.git(workspace.repo_root, ["branch", "-D", workspace.branch]);
        return { run_id: runId, discarded: true };
    }
    async shutdown() {
        this.shuttingDown = true;
        const runs = [...this.active.values()];
        for (const run of runs) {
            this.sendAbort(run);
            this.finalizeOnce(run.run_id, "stopped", "");
            this.killRun(run, "SIGKILL");
            this.cleanup(run.run_id);
        }
        this.options.store.close();
    }
    handleEvent(runId, event) {
        if (this.shuttingDown)
            return;
        const name = String(event.event ?? event.method ?? event.type ?? "");
        const params = event.params && typeof event.params === "object" ? event.params : event;
        if (name === "tool_execution_start") {
            this.options.store.addToolCall({
                timestamp: new Date().toISOString(),
                run_id: runId,
                pi_tool_call_id: String(params.tool_call_id ?? params.toolCallId ?? params.id ?? "unknown"),
                tool_name: String(params.tool_name ?? params.toolName ?? params.name ?? "unknown"),
                arguments: (params.arguments ?? params.args) === undefined
                    ? undefined
                    : redactSecrets(params.arguments ?? params.args),
            });
            this.options.store.addRunEvent({
                timestamp: new Date().toISOString(),
                run_id: runId,
                kind: "tool_started",
                payload: {
                    tool: String(params.tool_name ?? params.toolName ?? params.name ?? "unknown"),
                    summary: summarizeToolStart(params),
                },
            });
            this.emitProgress(runId, "tool", String(params.tool_name ?? params.toolName ?? params.name ?? "unknown"));
        }
        if (name === "tool_execution_end") {
            const record = this.options.store.getRun(runId);
            const files = this.workspaceSummary(record?.workspace);
            if (files.length > 0) {
                this.options.store.addRunEvent({
                    timestamp: new Date().toISOString(),
                    run_id: runId,
                    kind: "workspace_changed",
                    payload: {
                        summary: `${files.length} file(s) changed`,
                        files: files.slice(0, 12),
                        total_files: files.length,
                    },
                });
            }
        }
        if (name === "session_created" || name === "session_started") {
            const sid = extractSessionId(params);
            if (sid) {
                const run = this.active.get(runId);
                if (run) {
                    run.sessionId = sid;
                    this.options.store.updateRunSessionId(runId, sid);
                }
            }
        }
        if (name === "agent_end") {
            this.emitProgress(runId, "finishing");
            const active = this.active.get(runId);
            const requestedState = String(params.state ?? params.status ?? "completed");
            const state = active?.state === "stopping"
                ? "stopped"
                : requestedState === "failed"
                    ? "failed"
                    : "completed";
            const finalAnswer = String(params.final_answer ??
                params.answer ??
                params.message ??
                extractFinalAnswer(params.messages) ??
                "");
            this.captureSessionId(runId, params);
            const sessionId = this.getRunSessionId(runId);
            this.finalizeOnce(runId, state, finalAnswer, state === "failed"
                ? String(params.error ?? "Pi run failed.")
                : undefined, sessionId);
        }
    }
    handleExit(runId, code, signal, exitError) {
        if (this.shuttingDown)
            return;
        const active = this.active.get(runId);
        if (!active)
            return;
        if (active.settled) {
            this.cleanup(runId);
            return;
        }
        const sessionId = this.getRunSessionId(runId);
        if (active.state === "stopping") {
            this.finalizeOnce(runId, "stopped", "", undefined, sessionId, false);
        }
        else {
            const error = exitError?.message ??
                `Pi process exited unexpectedly: code=${code} signal=${signal}`;
            this.finalizeOnce(runId, "failed", "", error, sessionId, false);
        }
        this.cleanup(runId);
    }
    failRun(runId, error) {
        const active = this.active.get(runId);
        if (!active || active.settled || TERMINAL_STATES.has(active.state))
            return;
        if (active.state === "stopping")
            return;
        const sessionId = this.getRunSessionId(runId);
        this.finalizeOnce(runId, "failed", "", error, sessionId);
    }
    transition(runId, next, fields, tolerateRace = false) {
        const active = this.active.get(runId);
        const current = active?.state ?? this.options.store.getRun(runId)?.state;
        if (!current) {
            if (tolerateRace)
                return false;
            throw new Error(`Unknown run_id: ${runId}`);
        }
        if (current === next)
            return true;
        if (!ALLOWED_TRANSITIONS[current].includes(next)) {
            if (tolerateRace && TERMINAL_STATES.has(current))
                return false;
            throw new Error(`Invalid run state transition: ${current} -> ${next}`);
        }
        if (active)
            active.state = next;
        this.options.store.updateRun(runId, next, fields);
        this.options.store.addRunEvent({
            timestamp: new Date().toISOString(),
            run_id: runId,
            kind: TERMINAL_STATES.has(next) ? "terminal" : "run_state",
            payload: {
                state: next,
                error: fields?.error
                    ? String(redactSecrets(fields.error)).slice(0, 500)
                    : undefined,
            },
        });
        process.stderr.write(JSON.stringify({
            level: "info",
            event: "run_state",
            run_id: runId,
            state: next,
        }) + "\n");
        return true;
    }
    validateWorkingDirectory(input) {
        if (!input || input.includes("\0"))
            throw new Error("Invalid working_directory.");
        const parts = input.split(/[\\/]+/);
        if (parts.includes(".."))
            throw new Error("Path traversal is not allowed in working_directory.");
        const resolved = path.resolve(input);
        const allowed = this.options.allowedRoots.map((root) => path.resolve(root));
        if (!allowed.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
            throw new Error(`working_directory must be under an allowed root: ${allowed.join(", ")}`);
        }
        const stat = fs.statSync(resolved);
        if (!stat.isDirectory())
            throw new Error("working_directory must be an existing directory.");
        return resolved;
    }
    prepareWorkspace(cwd, runId, mode = "auto") {
        if (mode === "direct") {
            return {
                mode: "direct",
                original_working_directory: cwd,
                agent_working_directory: cwd,
            };
        }
        const git = this.gitContext(cwd);
        if (!git) {
            if (mode === "worktree" || mode === "snapshot" || mode === "clean_head") {
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
        const worktreeRootName = this.options.worktreeRootName ??
            process.env.PI_BRIDGE_WORKTREE_ROOT_NAME ??
            ".pi-subagent-runs";
        const worktreesRoot = path.join(git.repoRoot, worktreeRootName);
        const worktreePath = path.join(worktreesRoot, runId);
        const artifactsDir = path.join(worktreePath, ".pi-bridge");
        const branch = `pi/run-${runSlug}`;
        let registered = false;
        try {
            fs.mkdirSync(worktreesRoot, { recursive: true });
            this.git(git.repoRoot, [
                "worktree",
                "add",
                "-b",
                branch,
                worktreePath,
                git.baseCommit,
            ]);
            registered = true;
            fs.mkdirSync(artifactsDir, { recursive: true });
            const useSnapshot = mode === "auto" || mode === "snapshot";
            let snapshotApplied = false;
            let agentBaseCommit = git.baseCommit;
            if (useSnapshot) {
                const dirtyPatch = this.git(git.repoRoot, [
                    "diff",
                    "--binary",
                    "HEAD",
                    "--",
                ]);
                if (dirtyPatch.trim()) {
                    const snapshotPatch = path.join(artifactsDir, "coordinator-snapshot.patch");
                    fs.writeFileSync(snapshotPatch, dirtyPatch, "utf8");
                    this.git(worktreePath, ["apply", "--binary", snapshotPatch]);
                    snapshotApplied = true;
                }
                const untracked = this.git(git.repoRoot, [
                    "ls-files",
                    "--others",
                    "--exclude-standard",
                ])
                    .split("\n")
                    .map((entry) => entry.trim())
                    .filter(Boolean)
                    .filter((entry) => !entry.startsWith(`${worktreeRootName}/`));
                const maxSnapshotBytes = Number.parseInt(process.env.PI_BRIDGE_MAX_SNAPSHOT_FILE_BYTES ?? "10485760", 10);
                const ignoredSnapshot = /(^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
                for (const relative of untracked) {
                    if (ignoredSnapshot.test(relative))
                        continue;
                    const source = path.join(git.repoRoot, relative);
                    const target = path.join(worktreePath, relative);
                    const stat = fs.lstatSync(source);
                    if (!stat.isFile() || stat.size > maxSnapshotBytes)
                        continue;
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.copyFileSync(source, target);
                    snapshotApplied = true;
                }
                if (snapshotApplied) {
                    this.git(worktreePath, ["add", "-A"]);
                    this.git(worktreePath, [
                        "-c",
                        "user.name=Pi Bridge",
                        "-c",
                        "user.email=pi-bridge@localhost",
                        "commit",
                        "-m",
                        "chore: snapshot coordinator workspace",
                    ]);
                    agentBaseCommit = this.git(worktreePath, [
                        "rev-parse",
                        "HEAD",
                    ]).trim();
                }
            }
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
                base_commit: agentBaseCommit,
                source_base_commit: git.baseCommit,
                snapshot_applied: snapshotApplied,
                target_commit: this.git(git.repoRoot, ["rev-parse", "HEAD"]).trim(),
                artifacts_dir: artifactsDir,
                status_path: path.join(artifactsDir, "status.txt"),
                patch_path: patchPath,
                metadata_path: path.join(artifactsDir, "workspace.json"),
                status_command: `git -C ${quoteShell(worktreePath)} status --short`,
                diff_command: `git -C ${quoteShell(worktreePath)} diff ${agentBaseCommit} --`,
                apply_command: `git -C ${quoteShell(git.repoRoot)} apply ${quoteShell(patchPath)}`,
                merge_command: `git -C ${quoteShell(git.repoRoot)} merge --no-ff ${quoteShell(branch)}`,
            };
        }
        catch (error) {
            if (registered) {
                try {
                    this.git(git.repoRoot, [
                        "worktree",
                        "remove",
                        "--force",
                        worktreePath,
                    ]);
                }
                catch {
                    fs.rmSync(worktreePath, { recursive: true, force: true });
                    try {
                        this.git(git.repoRoot, ["worktree", "prune"]);
                    }
                    catch { }
                }
            }
            try {
                this.git(git.repoRoot, ["branch", "-D", branch]);
            }
            catch { }
            throw error;
        }
    }
    messageForAgent(task, workspace) {
        const instructions = [
            "You are a coding subagent working for a coordinator.",
            "",
            "Follow these instructions in order:",
            "1. Treat the user task below as the authoritative request.",
            "2. Inspect the repository before changing files, and follow existing project patterns.",
            "3. Keep changes scoped to the task. Preserve unrelated user or repository changes.",
            "4. Make concrete file edits when the task asks for implementation; do not stop at advice unless the task is only a question or review.",
            "5. Run the most relevant verification available for your changes when feasible. If verification cannot be run, say why.",
            "6. In your final answer, summarize changed files and verification only. Do not paste full diffs or patches.",
        ];
        if (workspace.mode === "worktree") {
            instructions.push("", `Bridge workspace note: you are running in an isolated git worktree at ${workspace.agent_working_directory}. Make code changes in that worktree. The coordinator will inspect changes with git using the branch, worktree, and patch artifacts returned by the bridge.`);
        }
        return `${instructions.join("\n")}

User task:
${task}`;
    }
    finalizeWorkspace(runId) {
        const record = this.options.store.getRun(runId);
        const workspace = record?.workspace;
        if (!workspace ||
            workspace.mode !== "worktree" ||
            !workspace.worktree_path) {
            return workspace;
        }
        const finalized = { ...workspace };
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
                fs.writeFileSync(workspace.metadata_path, JSON.stringify(finalized, null, 2), "utf8");
            }
            this.options.store.updateRunWorkspace(runId, finalized);
            const files = this.workspaceSummary(finalized);
            this.options.store.addRunEvent({
                timestamp: new Date().toISOString(),
                run_id: runId,
                kind: "workspace_changed",
                payload: {
                    summary: `${finalized.changed_files?.length ?? 0} file(s) changed`,
                    files: files.slice(0, 12),
                    total_files: files.length,
                },
            });
            return finalized;
        }
        catch (error) {
            finalized.setup_error =
                error instanceof Error ? error.message : String(error);
            this.options.store.updateRunWorkspace(runId, finalized);
            return finalized;
        }
    }
    gitContext(cwd) {
        try {
            const repoRoot = this.git(cwd, ["rev-parse", "--show-toplevel"]).trim();
            const inside = this.git(cwd, [
                "rev-parse",
                "--is-inside-work-tree",
            ]).trim();
            if (inside !== "true")
                return undefined;
            const baseCommit = this.git(repoRoot, ["rev-parse", "HEAD"]).trim();
            return { repoRoot, baseCommit };
        }
        catch {
            return undefined;
        }
    }
    workspaceSummary(workspace) {
        if (!workspace?.base_commit)
            return [];
        try {
            return this.git(workspace.agent_working_directory, [
                "diff",
                "--numstat",
                workspace.base_commit,
                "--",
            ])
                .split("\n")
                .filter(Boolean)
                .map((line) => {
                const [added, removed, ...rest] = line.split("\t");
                return {
                    path: rest.join("\t"),
                    added: Number(added) || 0,
                    removed: Number(removed) || 0,
                };
            })
                .filter((file) => file.path !== ".pi-bridge" && !file.path.startsWith(".pi-bridge/"));
        }
        catch {
            return [];
        }
    }
    git(cwd, args) {
        return execFileSync("git", args, {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
    }
    clientFor(run) {
        return run.client;
    }
    argsFor(input) {
        const args = [...(this.options.piArgs ?? [])];
        if (input.session_id) {
            args.push(this.options.sessionIdFlag ?? "--session-id", input.session_id);
        }
        else if (this.options.noSessionFlag) {
            args.push(this.options.noSessionFlag);
        }
        if (input.provider)
            args.push("--provider", input.provider);
        if (input.model_id)
            args.push("--model", input.provider && !input.model_id.includes("/")
                ? `${input.provider}/${input.model_id}`
                : input.model_id);
        if (input.thinking_level)
            args.push("--thinking", input.thinking_level);
        return args.length > 0 ? args : undefined;
    }
    captureSessionId(runId, data) {
        const sid = extractSessionId(data) ?? this.inferSessionId(runId);
        if (!sid)
            return;
        const run = this.active.get(runId);
        if (!run)
            return;
        run.sessionId = sid;
        this.options.store.updateRunSessionId(runId, sid);
    }
    getRunSessionId(runId) {
        const run = this.active.get(runId);
        const sid = run?.sessionId;
        if (sid)
            return sid;
        const inferred = this.inferSessionId(runId);
        if (inferred)
            return inferred;
        return this.options.store.getRun(runId)?.session_id;
    }
    inferSessionId(runId) {
        const run = this.active.get(runId);
        if (!run)
            return undefined;
        const record = this.options.store.getRun(runId);
        if (!record || record.session_id)
            return record?.session_id;
        // Filesystem inference cannot safely assign a newly-created session when
        // multiple runs are racing in the same bridge process. Prefer no id over a
        // confidently wrong id; normal RPC session events remain authoritative.
        const inferable = [...this.active.values()].filter((candidate) => !candidate.sessionId && !candidate.settled);
        if (inferable.length > 1)
            return undefined;
        const snapshot = run.sessionSnapshot ?? new Map();
        const inferred = newestCreatedSessionId(this.sessionDirsFor(record.workspace?.agent_working_directory ?? record.working_directory), snapshot, run.startedAtMs);
        if (!inferred)
            return undefined;
        run.sessionId = inferred;
        this.options.store.updateRunSessionId(runId, inferred);
        return inferred;
    }
    sessionDirsFor(cwd) {
        const root = this.options.piSessionDir ??
            this.options.piEnv?.PI_CODING_AGENT_SESSION_DIR ??
            process.env.PI_CODING_AGENT_SESSION_DIR ??
            path.join(this.options.piEnv?.PI_CODING_AGENT_DIR ??
                process.env.PI_CODING_AGENT_DIR ??
                path.join(process.env.HOME ?? "", ".pi", "agent"), "sessions");
        const projectKey = sessionProjectKey(cwd);
        return [path.join(root, projectKey), root];
    }
    killRun(run, signal) {
        this.clientFor(run).terminate(signal);
    }
    sendAbort(run) {
        return this.clientFor(run).send(this.options.abortMethod, {
            run_id: run.run_id,
        });
    }
    emitProgress(runId, phase, latestTool) {
        if (!this.options.onProgress)
            return;
        const active = this.active.get(runId);
        if (!active)
            return;
        this.options.onProgress({
            run_id: runId,
            state: active.state,
            phase,
            elapsed_ms: Date.now() - active.startedAtMs,
            tool_calls_count: this.options.store.countToolCalls(runId),
            latest_tool: latestTool,
        });
    }
    cleanup(runId) {
        const run = this.active.get(runId);
        if (!run)
            return;
        if (run.timeoutTimer)
            clearTimeout(run.timeoutTimer);
        if (run.forceTimer)
            clearTimeout(run.forceTimer);
        if (run.killTimer)
            clearTimeout(run.killTimer);
        this.active.delete(runId);
    }
    finalizeOnce(runId, state, finalAnswer, error, sessionId = this.getRunSessionId(runId), terminate = true) {
        const run = this.active.get(runId);
        if (!run || run.settled)
            return false;
        run.settled = true;
        if (run.timeoutTimer)
            clearTimeout(run.timeoutTimer);
        if (run.forceTimer)
            clearTimeout(run.forceTimer);
        const storedAnswer = this.options.redactFinalAnswers && finalAnswer
            ? String(redactSecrets(finalAnswer))
            : finalAnswer;
        this.transition(runId, state, {
            error,
            final_answer: state === "completed" ? storedAnswer : undefined,
        }, true);
        const workspace = this.finalizeWorkspace(runId);
        run.resolveOnce({
            run_id: runId,
            state,
            final_answer: finalAnswer,
            error,
            session_id: sessionId,
            workspace,
        });
        this.emitProgress(runId, "terminal");
        if (terminate) {
            this.killRun(run, "SIGTERM");
            run.killTimer = setTimeout(() => {
                this.killRun(run, "SIGKILL");
                this.cleanup(runId);
            }, this.options.killGraceMs ?? 500);
        }
        else {
            this.cleanup(runId);
        }
        return true;
    }
    removeWorkspace(workspace) {
        if (!workspace?.repo_root || !workspace.worktree_path)
            return;
        try {
            this.git(workspace.repo_root, [
                "worktree",
                "remove",
                "--force",
                workspace.worktree_path,
            ]);
        }
        catch { }
        if (workspace.branch) {
            try {
                this.git(workspace.repo_root, ["branch", "-D", workspace.branch]);
            }
            catch { }
        }
    }
}
function extractFinalAnswer(messages) {
    if (!Array.isArray(messages))
        return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!isRecord(message) || message.role !== "assistant")
            continue;
        const text = textFromContent(message.content);
        if (text)
            return text;
    }
    return undefined;
}
function textFromContent(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    return content
        .map((part) => {
        if (typeof part === "string")
            return part;
        if (!isRecord(part))
            return "";
        return typeof part.text === "string"
            ? part.text
            : typeof part.content === "string"
                ? part.content
                : "";
    })
        .filter(Boolean)
        .join("");
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function extractSessionId(data) {
    if (!isRecord(data))
        return undefined;
    const sid = data.session_id ?? data.sessionId ?? data.session ?? undefined;
    return typeof sid === "string" && sid.length > 0 ? sid : undefined;
}
function sessionProjectKey(cwd) {
    const normalized = path
        .resolve(cwd)
        .split(path.sep)
        .filter(Boolean)
        .join("-");
    return `--${normalized}--`;
}
function snapshotSessionFiles(dirs) {
    const snapshot = new Map();
    for (const dir of dirs) {
        for (const file of sessionFiles(dir)) {
            snapshot.set(file.path, file.mtimeMs);
        }
    }
    return snapshot;
}
function newestCreatedSessionId(dirs, snapshot, startedAtMs) {
    let best;
    for (const dir of dirs) {
        for (const file of sessionFiles(dir)) {
            const previousMtime = snapshot.get(file.path);
            if (previousMtime !== undefined && previousMtime === file.mtimeMs) {
                continue;
            }
            if (file.mtimeMs < startedAtMs - 1000)
                continue;
            const sessionId = sessionIdFromPath(file.path);
            if (!sessionId)
                continue;
            if (!best || file.mtimeMs > best.mtimeMs) {
                best = { sessionId, mtimeMs: file.mtimeMs };
            }
        }
    }
    return best?.sessionId;
}
function sessionFiles(dir) {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => {
            const filePath = path.join(dir, entry.name);
            return { path: filePath, mtimeMs: fs.statSync(filePath).mtimeMs };
        });
    }
    catch {
        return [];
    }
}
function sessionIdFromPath(filePath) {
    const match = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(path.basename(filePath));
    return match?.[1];
}
function summarizeToolStart(params) {
    const tool = String(params.tool_name ?? params.toolName ?? params.name ?? "tool");
    const args = redactSecrets(params.arguments ?? params.args);
    if (isRecord(args)) {
        const command = args.command ?? args.path ?? args.file_path ?? args.query;
        if (typeof command === "string")
            return `${tool}: ${command.slice(0, 240)}`;
    }
    return `Started ${tool}`;
}
function phaseFromEvents(events, state) {
    if (TERMINAL_STATES.has(state))
        return "terminal";
    const last = events.at(-1);
    if (!last)
        return "starting";
    if (last.kind === "terminal")
        return "terminal";
    if (last.kind === "tool_started")
        return "tool";
    if (last.kind === "run_state" && last.payload.state === "running")
        return "running";
    return "finishing";
}
function eventSummary(event) {
    const payload = event.payload;
    if (event.kind === "tool_started")
        return String(payload.summary ?? "Started tool");
    if (event.kind === "workspace_changed")
        return String(payload.summary ?? "Workspace changed");
    if (event.kind === "steer_sent")
        return "Coordinator steering sent";
    if (event.kind === "steer_acknowledged")
        return "Coordinator steering acknowledged";
    if (event.kind === "steer_failed")
        return "Coordinator steering delivery failed";
    if (event.kind === "terminal")
        return `Run ${String(payload.state ?? "ended")}`;
    return `Run state: ${String(payload.state ?? "updated")}`;
}
function parseUntrackedFiles(status) {
    return status
        .split("\n")
        .filter((line) => line.startsWith("?? "))
        .map((line) => line.slice(3).trim())
        .filter(Boolean);
}
function quoteShell(value) {
    return `'${value.replace(/'/g, "'\\''")}'`;
}
