import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
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
  session_id: z.string().optional(),
  workspace_mode: z
    .enum(["auto", "snapshot", "clean_head", "worktree", "direct"])
    .optional(),
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
  piArgs: splitArgs(process.env.PI_RPC_ARGS) ?? ["--mode", "rpc"],
  piSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
  allowedRoots: (process.env.PI_ALLOWED_ROOTS ?? defaultAllowedRoot())
    .split(path.delimiter)
    .filter(Boolean),
  maxRuntimeMs: envInt("PI_BRIDGE_MAX_RUNTIME_MS", 30 * 60 * 1000),
  stopGraceMs: envInt("PI_BRIDGE_STOP_GRACE_MS", 5000),
  startMethod: process.env.PI_RPC_START_METHOD ?? "prompt",
  abortMethod: process.env.PI_RPC_ABORT_METHOD ?? "abort",
  worktreeRootName: process.env.PI_BRIDGE_WORKTREE_ROOT_NAME,
  sessionIdFlag: process.env.PI_RPC_SESSION_ID_FLAG ?? "--session-id",
  noSessionFlag: process.env.PI_RPC_NO_SESSION_FLAG,
  onProgress: (event) => {
    void server
      ?.sendLoggingMessage({
        level: "info",
        logger: "pi-subagent-bridge",
        data: event,
      })
      .catch(() => undefined);
  },
});

const server = new Server(
  { name: "pi-subagent-bridge", version: "0.1.0" },
  { capabilities: { tools: {} } },
);
server.onerror = (error) => {
  console.error(
    JSON.stringify({
      level: "error",
      component: "mcp",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pi_run",
      description:
        "Preferred one-call delegation API. Start a Pi coding subagent, wait for completion, and return its answer and structured workspace handoff.",
      inputSchema: {
        type: "object",
        required: ["task", "working_directory"],
        properties: {
          task: { type: "string" },
          working_directory: { type: "string" },
          provider: { type: "string" },
          model_id: { type: "string" },
          thinking_level: { type: "string" },
          session_id: { type: "string" },
          workspace_mode: {
            type: "string",
            enum: ["auto", "snapshot", "clean_head", "worktree", "direct"],
          },
        },
        additionalProperties: false,
      },
      outputSchema: runResultSchema(),
      annotations: {
        title: "Delegate to Pi",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "pi_list_models",
      description:
        "Search Pi's structured RPC model catalog. Use a focused query when selecting a model; do not scrape terminal output.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional search text, for example 'gpt 5.5 reasoning'.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Search Pi models",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "pi_start",
      description:
        "Start a Pi RPC subprocess and return a stable run_id immediately. Optionally pass a session_id to continue that Pi session.",
      inputSchema: {
        type: "object",
        required: ["task", "working_directory"],
        properties: {
          task: { type: "string" },
          working_directory: { type: "string" },
          provider: { type: "string" },
          model_id: { type: "string" },
          thinking_level: { type: "string" },
          session_id: {
            type: "string",
            description:
              "Optional Pi session ID to continue. When absent Pi creates a new persistent session and returns its ID in diagnostics and results.",
          },
          workspace_mode: {
            type: "string",
            enum: ["auto", "snapshot", "clean_head", "worktree", "direct"],
            description:
              "Workspace isolation mode. Default auto uses an isolated git worktree when working_directory is in a git repo and returns compact diff/status references instead of inline patches.",
          },
        },
        additionalProperties: false,
      },
      annotations: {
        title: "Start Pi run",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "pi_doctor",
      description:
        "Check bridge, Pi executable, state directory, allowed roots, and git availability.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" }, checks: { type: "array" } },
        required: ["ok", "checks"],
      },
      annotations: {
        title: "Diagnose Pi bridge",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: "pi_wait",
      description:
        "Wait for a Pi run to reach a terminal state. When timeout_ms is set, returns a progress heartbeat before the timeout elapses instead of blocking until completion. This is not a polling API and request cancellation does not stop the Pi run.",
      inputSchema: {
        type: "object",
        required: ["run_id"],
        properties: {
          run_id: { type: "string" },
          timeout_ms: {
            type: "number",
            description:
              "Maximum milliseconds to wait before returning a progress heartbeat with state, elapsed_ms, and tool_calls_count. Omit to block until the run completes.",
          },
        },
      },
    },
    {
      name: "pi_apply_changes",
      description:
        "Safely apply a completed isolated Pi run's patch after checking the target revision and patch conflicts.",
      inputSchema: {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
        additionalProperties: false,
      },
      annotations: {
        title: "Apply Pi changes",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "pi_discard_workspace",
      description: "Remove a completed Pi run's isolated worktree and branch.",
      inputSchema: {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
        additionalProperties: false,
      },
      annotations: {
        title: "Discard Pi workspace",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    {
      name: "pi_stop",
      description:
        "Abort a Pi run, then terminate its process group after the configured grace period if needed.",
      inputSchema: {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
      },
    },
    {
      name: "pi_recent_tool_calls",
      description:
        "Return recent sanitized tool_execution_start audit entries. Do not use as a polling loop.",
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
      description:
        "Return diagnostic state including any session_id for recovery and debugging. Not the normal waiting mechanism.",
      inputSchema: {
        type: "object",
        required: ["run_id"],
        properties: { run_id: { type: "string" } },
      },
    },
    {
      name: "pi_read_result",
      description:
        "Read an already completed result if the original wait connection was interrupted.",
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
      case "pi_run": {
        const started = await manager.start(StartSchema.parse(args ?? {}));
        return jsonResult(await manager.wait(started.run_id));
      }
      case "pi_list_models":
        return jsonResult(
          await listModels(
            {
              executable: process.env.PI_EXECUTABLE ?? "pi",
              rpcArgs: splitArgs(process.env.PI_RPC_ARGS) ?? ["--mode", "rpc"],
              timeoutMs: envInt("PI_BRIDGE_MODEL_LIST_TIMEOUT_MS", 15000),
              modelListMethod:
                process.env.PI_RPC_MODEL_LIST_METHOD ?? "get_available_models",
            },
            ModelsSchema.parse(args ?? {}).query,
          ),
        );
      case "pi_start":
        return jsonResult(await manager.start(StartSchema.parse(args ?? {})));
      case "pi_doctor":
        return jsonResult(doctor());
      case "pi_wait": {
        const waitArgs = z
          .object({
            run_id: z.string().uuid(),
            timeout_ms: z.number().int().min(1).optional(),
          })
          .parse(args ?? {});
        return jsonResult(
          await manager.wait(waitArgs.run_id, waitArgs.timeout_ms),
        );
      }
      case "pi_stop":
        return jsonResult(
          await manager.stop(RunIdSchema.parse(args ?? {}).run_id),
        );
      case "pi_apply_changes":
        return jsonResult(
          manager.applyChanges(RunIdSchema.parse(args ?? {}).run_id),
        );
      case "pi_discard_workspace":
        return jsonResult(
          manager.discardWorkspace(RunIdSchema.parse(args ?? {}).run_id),
        );
      case "pi_recent_tool_calls": {
        const parsed = RecentSchema.parse(args ?? {});
        return jsonResult(manager.recentToolCalls(parsed.limit, parsed.run_id));
      }
      case "pi_get_run":
        return jsonResult(manager.getRun(RunIdSchema.parse(args ?? {}).run_id));
      case "pi_read_result":
        return jsonResult(
          manager.readResult(RunIdSchema.parse(args ?? {}).run_id),
        );
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
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

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: summarizeResult(value) }],
    structuredContent:
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { result: value },
  };
}

function summarizeResult(value: unknown): string {
  if (value && typeof value === "object" && "state" in value) {
    const result = value as {
      state?: unknown;
      final_answer?: unknown;
      error?: unknown;
    };
    return [
      String(result.state ?? "unknown"),
      result.final_answer,
      result.error,
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return JSON.stringify(value, null, 2);
}

function runResultSchema() {
  return {
    type: "object" as const,
    properties: {
      run_id: { type: "string" },
      state: { type: "string" },
      final_answer: { type: "string" },
      error: { type: "string" },
      session_id: { type: "string" },
      workspace: { type: "object" },
    },
    required: ["run_id", "state", "final_answer"],
  };
}

function doctor() {
  const checks: Array<{
    name: string;
    ok: boolean;
    detail: string;
    code?: string;
  }> = [];
  const command = process.env.PI_EXECUTABLE ?? "pi";
  const executable = command.includes(path.sep)
    ? fs.existsSync(command)
    : (process.env.PATH ?? "")
        .split(path.delimiter)
        .some((dir) => fs.existsSync(path.join(dir, command)));
  checks.push({
    name: "pi_executable",
    ok: executable,
    detail: command,
    code: executable ? undefined : "PI_NOT_FOUND",
  });
  checks.push({ name: "state_directory", ok: true, detail: dataDir });
  checks.push({
    name: "allowed_roots",
    ok: true,
    detail: process.env.PI_ALLOWED_ROOTS ?? defaultAllowedRoot(),
  });
  const git = (process.env.PATH ?? "")
    .split(path.delimiter)
    .some((dir) => fs.existsSync(path.join(dir, "git")));
  checks.push({
    name: "git",
    ok: git,
    detail: git ? "available" : "not found",
    code: git ? undefined : "GIT_NOT_FOUND",
  });
  return { ok: checks.every((check) => check.ok), checks };
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitArgs(input?: string): string[] | undefined {
  return input ? input.split(/\s+/).filter(Boolean) : undefined;
}

function dataDirCandidates(): string[] {
  if (process.env.PI_BRIDGE_DATA_DIR) {
    return [path.resolve(process.env.PI_BRIDGE_DATA_DIR)];
  }
  const stateRoot =
    process.env.XDG_STATE_HOME ??
    (process.env.HOME ? path.join(process.env.HOME, ".local", "state") : "");
  return [
    ...(stateRoot ? [path.join(stateRoot, "pi-subagent-bridge")] : []),
    path.join(os.tmpdir(), "pi-subagent-bridge"),
  ];
}

function prepareDataDir(): string {
  const errors: string[] = [];
  for (const candidate of dataDirCandidates()) {
    try {
      fs.mkdirSync(candidate, { recursive: true });
      fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK);
      return candidate;
    } catch (error) {
      errors.push(
        `${candidate}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  throw new Error(
    `No writable Pi bridge data directory found: ${errors.join("; ")}`,
  );
}

function defaultAllowedRoot(): string {
  return process.env.HOME ?? process.cwd();
}

async function shutdown(code: number): Promise<void> {
  clearInterval(keepAlive);
  await manager.shutdown();
  process.exit(code);
}
