import type { ChildProcessWithoutNullStreams } from "node:child_process";

export type RunState =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopping"
  | "stopped"
  | "timed_out";

export type TerminalState = "completed" | "failed" | "stopped" | "timed_out";

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
}

export interface RunResult {
  run_id: string;
  state: TerminalState;
  final_answer: string;
  error?: string;
  session_id?: string;
}

export interface ToolCallAudit {
  sequence: number;
  timestamp: string;
  run_id: string;
  pi_tool_call_id: string;
  tool_name: string;
  arguments?: unknown;
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
}
