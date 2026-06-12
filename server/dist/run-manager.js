import crypto from "node:crypto";
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
    starting: ["running", "completed", "failed", "stopping", "timed_out"],
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
        if (this.active.size >= this.options.maxConcurrentRuns) {
            throw new Error(`Concurrency limit reached (${this.options.maxConcurrentRuns}).`);
        }
        const cwd = this.validateWorkingDirectory(input.working_directory);
        const runId = crypto.randomUUID();
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
            : snapshotSessionFiles(this.sessionDirsFor(cwd));
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
        const run = {
            run_id: runId,
            child: client.child,
            state: "starting",
            startedAtMs: Date.now(),
            waitPromise,
            resolveOnce,
            stopRequested: false,
            abortSent: false,
        };
        run.client = client;
        run.sessionId = sessionId;
        run.sessionSnapshot = sessionSnapshot;
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
            });
            this.active.delete(runId);
        }, this.options.maxRuntimeMs);
        client
            .request(this.options.startMethod, {
            message: input.task,
        })
            .then((data) => {
            this.captureSessionId(runId, data);
            this.transition(runId, "running");
        })
            .catch((error) => {
            const active = this.active.get(runId);
            if (active?.state === "stopping")
                return;
            this.failRun(runId, `Pi start failed: ${error.message}`);
        });
        return { run_id: runId, session_id: sessionId };
    }
    wait(runId) {
        const active = this.active.get(runId);
        if (active)
            return active.waitPromise;
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
        });
    }
    async stop(runId) {
        const active = this.active.get(runId);
        if (!active)
            return this.getRun(runId);
        if (TERMINAL_STATES.has(active.state))
            return this.getRun(runId);
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
                            session_id: this.getRunSessionId(runId),
                        });
                        this.cleanup(runId);
                    }
                }, 500);
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
        };
    }
    recentToolCalls(limit, runId) {
        return this.options.store.recentToolCalls(limit, runId);
    }
    async shutdown() {
        this.shuttingDown = true;
        const runs = [...this.active.values()];
        for (const run of runs) {
            this.clientFor(run).send(this.options.abortMethod, {
                run_id: run.run_id,
            });
            this.killRun(run, "SIGTERM");
            this.transition(run.run_id, run.state === "stopping" ? "stopped" : "stopping");
            this.transition(run.run_id, "stopped");
            run.resolveOnce({
                run_id: run.run_id,
                state: "stopped",
                final_answer: "",
                session_id: this.getRunSessionId(run.run_id),
            });
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
            this.transition(runId, state, {
                final_answer: state === "completed" ? finalAnswer : undefined,
                error: state === "failed"
                    ? String(params.error ?? "Pi run failed.")
                    : undefined,
            });
            active?.resolveOnce({
                run_id: runId,
                state,
                final_answer: finalAnswer,
                error: state === "failed"
                    ? String(params.error ?? "Pi run failed.")
                    : undefined,
                session_id: sessionId,
            });
            if (active)
                this.killRun(active, "SIGTERM");
            this.cleanup(runId);
        }
    }
    handleExit(runId, code, signal) {
        if (this.shuttingDown)
            return;
        const active = this.active.get(runId);
        if (!active || TERMINAL_STATES.has(active.state))
            return;
        const sessionId = this.getRunSessionId(runId);
        if (active.state === "stopping") {
            this.transition(runId, "stopped");
            active.resolveOnce({
                run_id: runId,
                state: "stopped",
                final_answer: "",
                session_id: sessionId,
            });
        }
        else {
            this.transition(runId, "failed", {
                error: `Pi process exited unexpectedly: code=${code} signal=${signal}`,
            });
            active.resolveOnce({
                run_id: runId,
                state: "failed",
                final_answer: "",
                error: `Pi process exited unexpectedly: code=${code} signal=${signal}`,
                session_id: sessionId,
            });
        }
        this.cleanup(runId);
    }
    failRun(runId, error) {
        const active = this.active.get(runId);
        if (!active || TERMINAL_STATES.has(active.state))
            return;
        if (active.state === "stopping")
            return;
        const sessionId = this.getRunSessionId(runId);
        this.transition(runId, "failed", { error });
        active.resolveOnce({
            run_id: runId,
            state: "failed",
            final_answer: "",
            error,
            session_id: sessionId,
        });
        this.cleanup(runId);
    }
    transition(runId, next, fields) {
        const active = this.active.get(runId);
        const current = active?.state ?? this.options.store.getRun(runId)?.state;
        if (!current)
            throw new Error(`Unknown run_id: ${runId}`);
        if (current === next)
            return;
        if (!ALLOWED_TRANSITIONS[current].includes(next)) {
            throw new Error(`Invalid run state transition: ${current} -> ${next}`);
        }
        if (active)
            active.state = next;
        this.options.store.updateRun(runId, next, fields);
        process.stderr.write(JSON.stringify({
            level: "info",
            event: "run_state",
            run_id: runId,
            state: next,
        }) + "\n");
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
        const sid = run?.sessionId ??
            undefined;
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
        const snapshot = run
            .sessionSnapshot ?? new Map();
        const inferred = newestCreatedSessionId(this.sessionDirsFor(record.working_directory), snapshot, run.startedAtMs);
        if (!inferred)
            return undefined;
        run.sessionId = inferred;
        this.options.store.updateRunSessionId(runId, inferred);
        return inferred;
    }
    sessionDirsFor(cwd) {
        const root = this.options.piSessionDir ??
            process.env.PI_CODING_AGENT_SESSION_DIR ??
            path.join(process.env.PI_CODING_AGENT_DIR ??
                path.join(process.env.HOME ?? "", ".pi", "agent"), "sessions");
        const projectKey = sessionProjectKey(cwd);
        return [path.join(root, projectKey), root];
    }
    killRun(run, signal) {
        this.clientFor(run).terminate(signal);
    }
    cleanup(runId) {
        const run = this.active.get(runId);
        if (!run)
            return;
        if (run.timeoutTimer)
            clearTimeout(run.timeoutTimer);
        if (run.forceTimer)
            clearTimeout(run.forceTimer);
        this.active.delete(runId);
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
    const normalized = path.resolve(cwd).split(path.sep).filter(Boolean).join("-");
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
