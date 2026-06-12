import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { listModels } from "./model-catalog.js";
import { RunManager } from "./run-manager.js";
import { ToolCallStore } from "./tool-call-store.js";
const StartSchema = z.object({
    task: z.string().min(1),
    working_directory: z.string().min(1),
    provider: z.string().optional(),
    model_id: z.string().optional(),
    thinking_level: z.string().optional(),
});
const RunIdSchema = z.object({ run_id: z.string().uuid() });
const RecentSchema = z.object({
    run_id: z.string().uuid().optional(),
    limit: z.number().int().min(1).max(500).optional(),
});
const ModelsSchema = z.object({ query: z.string().optional() });
const dataDir = prepareDataDir();
const store = new ToolCallStore(path.join(dataDir, "state.sqlite"), {
    maxToolCalls: envInt("PI_BRIDGE_MAX_TOOL_CALLS", 1000),
    maxRuns: envInt("PI_BRIDGE_MAX_RUNS", 200),
});
const manager = new RunManager({
    store,
    piExecutable: process.env.PI_EXECUTABLE ?? "pi",
    piArgs: splitArgs(process.env.PI_RPC_ARGS) ?? [
        "--mode",
        "rpc",
        "--no-session",
    ],
    allowedRoots: (process.env.PI_ALLOWED_ROOTS ?? defaultAllowedRoot())
        .split(path.delimiter)
        .filter(Boolean),
    maxConcurrentRuns: envInt("PI_BRIDGE_MAX_CONCURRENT_RUNS", 3),
    maxRuntimeMs: envInt("PI_BRIDGE_MAX_RUNTIME_MS", 30 * 60 * 1000),
    stopGraceMs: envInt("PI_BRIDGE_STOP_GRACE_MS", 5000),
    startMethod: process.env.PI_RPC_START_METHOD ?? "prompt",
    abortMethod: process.env.PI_RPC_ABORT_METHOD ?? "abort",
});
const server = new Server({ name: "pi-subagent-bridge", version: "0.1.0" }, { capabilities: { tools: {} } });
server.onerror = (error) => {
    console.error(JSON.stringify({
        level: "error",
        component: "mcp",
        message: error instanceof Error ? error.message : String(error),
    }));
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "pi_list_models",
            description: "Search Pi's structured RPC model catalog. Use a focused query when selecting a model; do not scrape terminal output.",
            inputSchema: {
                type: "object",
                properties: {
                    query: {
                        type: "string",
                        description: "Optional search text, for example 'gpt 5.5 reasoning'.",
                    },
                },
                additionalProperties: false,
            },
        },
        {
            name: "pi_start",
            description: "Start one isolated Pi RPC subprocess and return a stable run_id immediately.",
            inputSchema: {
                type: "object",
                required: ["task", "working_directory"],
                properties: {
                    task: { type: "string" },
                    working_directory: { type: "string" },
                    provider: { type: "string" },
                    model_id: { type: "string" },
                    thinking_level: { type: "string" },
                },
                additionalProperties: false,
            },
        },
        {
            name: "pi_wait",
            description: "Wait once for a Pi run's terminal agent_end event. This is not a polling API and request cancellation does not stop the Pi run.",
            inputSchema: {
                type: "object",
                required: ["run_id"],
                properties: { run_id: { type: "string" } },
            },
        },
        {
            name: "pi_stop",
            description: "Abort a Pi run, then terminate its process group after the configured grace period if needed.",
            inputSchema: {
                type: "object",
                required: ["run_id"],
                properties: { run_id: { type: "string" } },
            },
        },
        {
            name: "pi_recent_tool_calls",
            description: "Return recent sanitized tool_execution_start audit entries. Do not use as a polling loop.",
            inputSchema: {
                type: "object",
                properties: {
                    run_id: { type: "string" },
                    limit: { type: "number", minimum: 1, maximum: 500 },
                },
                additionalProperties: false,
            },
        },
        {
            name: "pi_get_run",
            description: "Return diagnostic state for recovery and debugging. Not the normal waiting mechanism.",
            inputSchema: {
                type: "object",
                required: ["run_id"],
                properties: { run_id: { type: "string" } },
            },
        },
        {
            name: "pi_read_result",
            description: "Read an already completed result if the original wait connection was interrupted.",
            inputSchema: {
                type: "object",
                required: ["run_id"],
                properties: { run_id: { type: "string" } },
            },
        },
    ],
}));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
        switch (name) {
            case "pi_list_models":
                return jsonResult(await listModels({
                    executable: process.env.PI_EXECUTABLE ?? "pi",
                    rpcArgs: splitArgs(process.env.PI_RPC_ARGS) ?? [
                        "--mode",
                        "rpc",
                        "--no-session",
                    ],
                    timeoutMs: envInt("PI_BRIDGE_MODEL_LIST_TIMEOUT_MS", 15000),
                    modelListMethod: process.env.PI_RPC_MODEL_LIST_METHOD ?? "get_available_models",
                }, ModelsSchema.parse(args ?? {}).query));
            case "pi_start":
                return jsonResult(await manager.start(StartSchema.parse(args ?? {})));
            case "pi_wait":
                return jsonResult(await manager.wait(RunIdSchema.parse(args ?? {}).run_id));
            case "pi_stop":
                return jsonResult(await manager.stop(RunIdSchema.parse(args ?? {}).run_id));
            case "pi_recent_tool_calls": {
                const parsed = RecentSchema.parse(args ?? {});
                return jsonResult(manager.recentToolCalls(parsed.limit, parsed.run_id));
            }
            case "pi_get_run":
                return jsonResult(manager.getRun(RunIdSchema.parse(args ?? {}).run_id));
            case "pi_read_result":
                return jsonResult(manager.readResult(RunIdSchema.parse(args ?? {}).run_id));
            default:
                throw new Error(`Unknown tool: ${name}`);
        }
    }
    catch (error) {
        return {
            isError: true,
            content: [
                {
                    type: "text",
                    text: error instanceof Error ? error.message : String(error),
                },
            ],
        };
    }
});
process.once("SIGINT", () => void shutdown(0));
process.once("SIGTERM", () => void shutdown(0));
process.once("beforeExit", () => void manager.shutdown());
const keepAlive = setInterval(() => undefined, 1 << 30);
await server.connect(new StdioServerTransport());
process.stdin.resume();
function jsonResult(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    };
}
function envInt(name, fallback) {
    const parsed = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function splitArgs(input) {
    return input ? input.split(/\s+/).filter(Boolean) : undefined;
}
function dataDirCandidates() {
    if (process.env.PI_BRIDGE_DATA_DIR) {
        return [path.resolve(process.env.PI_BRIDGE_DATA_DIR)];
    }
    const stateRoot = process.env.XDG_STATE_HOME ??
        (process.env.HOME ? path.join(process.env.HOME, ".local", "state") : "");
    return [
        ...(stateRoot ? [path.join(stateRoot, "pi-subagent-bridge")] : []),
        path.join(os.tmpdir(), "pi-subagent-bridge"),
    ];
}
function prepareDataDir() {
    const errors = [];
    for (const candidate of dataDirCandidates()) {
        try {
            fs.mkdirSync(candidate, { recursive: true });
            fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
            return candidate;
        }
        catch (error) {
            errors.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    throw new Error(`No writable Pi bridge data directory found: ${errors.join("; ")}`);
}
function defaultAllowedRoot() {
    return process.env.HOME ?? process.cwd();
}
async function shutdown(code) {
    clearInterval(keepAlive);
    await manager.shutdown();
    process.exit(code);
}
