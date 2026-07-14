import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { PiRpcClient } from "./pi-rpc-client.js";

export type RunState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "timed_out";

export type TerminalState = "completed" | "failed" | "stopped" | "timed_out";

export interface WaitProgress {
  elapsed_ms: number;
  tool_calls_count: number;
}

export interface ModelInfo {
  provider: string;
  model_id: string;
  display_name: string;
  reasoning_support: boolean;
  context_window: number | null;
  maximum_output_tokens: number | null;
  supported_input_types: string[];
}

export interface StartRunInput {
  task: string;
  working_directory: string;
  provider?: string;
  model_id?: string;
  thinking_level?: string;
  session_id?: string;
  workspace_mode?: "auto" | "snapshot" | "clean_head" | "worktree" | "direct";
}

export interface RunWorkspace {
  mode: "direct" | "worktree";
  original_working_directory: string;
  agent_working_directory: string;
  repo_root?: string;
  worktree_path?: string;
  branch?: string;
  base_commit?: string;
  source_base_commit?: string;
  snapshot_applied?: boolean;
  target_commit?: string;
  artifacts_dir?: string;
  status_path?: string;
  patch_path?: string;
  metadata_path?: string;
  diff_command?: string;
  status_command?: string;
  apply_command?: string;
  merge_command?: string;
  changed_files?: string[];
  untracked_files?: string[];
  has_changes?: boolean;
  setup_error?: string;
}

export interface RunResult {
  run_id: string;
  state: RunState;
  final_answer: string;
  error?: string;
  session_id?: string;
  workspace?: RunWorkspace;
  progress?: WaitProgress;
}

export interface ToolCallAudit {
  sequence: number;
  timestamp: string;
  run_id: string;
  pi_tool_call_id: string;
  tool_name: string;
  arguments?: unknown;
}

export type RunEventKind =
  | "run_state"
  | "tool_started"
  | "workspace_changed"
  | "steer_sent"
  | "steer_acknowledged"
  | "steer_failed"
  | "terminal";

export interface RunEvent {
  sequence: number;
  timestamp: string;
  run_id: string;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface ChangedFileSummary {
  path: string;
  added: number;
  removed: number;
}

export interface RunSnapshot {
  run_id: string;
  state: RunState;
  phase: RunProgressEvent["phase"];
  elapsed_ms: number;
  last_activity_at: string;
  latest_activity?: string;
  tool_calls_count: number;
  changed_files: ChangedFileSummary[];
  total_changed_files: number;
  recent_progress: string[];
  event_cursor: number;
}

export interface RunDiagnostics {
  run_id: string;
  state: RunState;
  created_at: string;
  updated_at: string;
  working_directory: string;
  provider?: string;
  model_id?: string;
  thinking_level?: string;
  session_id?: string;
  error?: string;
  has_result: boolean;
  workspace?: RunWorkspace;
}

export interface RunRecord extends RunDiagnostics {
  task: string;
  final_answer?: string;
}

export interface ActiveRun {
  run_id: string;
  child: ChildProcessWithoutNullStreams;
  state: RunState;
  startedAtMs: number;
  waitPromise: Promise<RunResult>;
  resolveOnce: (result: RunResult) => void;
  stopRequested: boolean;
  abortSent: boolean;
  forceTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  client: PiRpcClient;
  sessionId?: string;
  sessionSnapshot?: Map<string, number>;
  settled: boolean;
}

export interface RunProgressEvent {
  run_id: string;
  state: RunState;
  phase: "starting" | "running" | "tool" | "finishing" | "terminal";
  elapsed_ms: number;
  tool_calls_count: number;
  latest_tool?: string;
}
