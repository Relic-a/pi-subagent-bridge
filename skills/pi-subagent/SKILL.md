---
name: pi-subagent
description: Use Pi coding-agent subprocesses through the bundled pi-subagent-bridge MCP server.
---

# Pi Subagent

Use this skill when the user asks Codex to delegate coding work to Pi, compare Pi models, or inspect Pi sub-agent activity.

## Workflow

- Prefer the default Pi model unless the task clearly needs a particular provider, context size, reasoning support, or input capability.
- Use `pi_list_models` only when model selection is necessary. Prefer a focused `query` such as `"gpt 5.5 reasoning"` instead of listing every model.
- Call `pi_start` once for a task. Provide the task, working directory, provider if selected, model ID if selected, optional thinking level, and optional `session_id` to continue an existing Pi session.
- Use `pi_wait`, `pi_read_result`, or `pi_get_run` to retrieve the run's `session_id`. Pass that `session_id` to a subsequent `pi_start` to continue the conversation.
- Call `pi_wait` with `timeout_ms: 100000` (100 seconds) to receive a progress heartbeat before the MCP transport timeout. On a heartbeat response (state is not terminal and `progress` is present), call `pi_wait` again with the same `run_id` and `timeout_ms`.
- A heartbeat response includes `{"state": "running", "progress": {"elapsed_ms": ..., "tool_calls_count": ...}}`. Do not treat this as a terminal result.
- Omit `timeout_ms` or set it to 0 to block until the run completes (only suitable when the MCP transport timeout is very high).
- Use `pi_read_result` only when the original wait connection was interrupted after the Pi run completed.
- Use `pi_get_run` for diagnostics and recovery only. It also exposes the `session_id` for the run.
- Prefer the default `workspace_mode` of `auto`; git repositories run in isolated worktrees so Pi can edit independently from Codex.
- When a result includes `workspace`, inspect changes through `workspace.status_command`, `workspace.diff_command`, `workspace.patch_path`, or the listed `changed_files`. Do not request or paste the full patch into model context unless the task specifically needs it.
- Integrate Pi work deliberately from the primary checkout by applying `workspace.patch_path`, merging `workspace.branch`, or manually porting selected files.
- Use `pi_stop` only when the user explicitly asks to cancel a Pi run.
- Use `pi_recent_tool_calls` for occasional inspection of current activity. Never use it as a status-polling loop.

## Safety

- Avoid exposing credentials or complete sensitive command arguments in Pi prompts.
- Do not paste complete secret-bearing tool arguments back to the user.
- Treat `pi_recent_tool_calls` arguments as sanitized summaries, not authoritative raw command logs.
