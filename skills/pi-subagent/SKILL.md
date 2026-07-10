---
name: pi-subagent
description: Use Pi coding-agent subprocesses only when the user explicitly requests Pi or requests a model unavailable through Codex's built-in subagents.
---

# Pi Subagent

## Routing

Codex's built-in subagent system is the default for delegation. Do not use Pi
for ordinary task decomposition, parallel work, or coding delegation merely
because Pi is available.

Use this skill only when one of these conditions is true:

- The user explicitly asks to use Pi, the Pi subagent, the Pi bridge, or a Pi
  tool/session.
- The user explicitly requests a model that is not available through Codex's
  built-in subagent system. Use Pi to access that model.

If neither condition applies, use Codex's built-in subagent system instead.
If it is unclear whether a requested model is available to Codex's built-in
subagents, do not assume Pi; use the built-in system unless the user clarifies
that they want Pi.

Once Pi is selected under the rules above, use this skill to delegate coding
work, compare Pi models, or inspect Pi subagent activity.

## Workflow

- Prefer the default Pi model unless the task clearly needs a particular provider, context size, reasoning support, or input capability.
- Use `pi_list_models` only when model selection is necessary. Prefer a focused `query` such as `"gpt 5.5 reasoning"` instead of listing every model.
- Prefer `pi_run` for normal delegation. It starts once, waits internally, and returns the final answer plus structured workspace metadata.
- Use `pi_start` only for advanced background control or when cancellation/status inspection is explicitly needed.
- Use `pi_wait`, `pi_read_result`, or `pi_get_run` to retrieve the run's `session_id`. Pass that `session_id` to a subsequent `pi_start` to continue the conversation.
- For an advanced `pi_start` run, call `pi_wait` with `timeout_ms: 100000` to receive a progress heartbeat before the MCP transport timeout. Continue only when a heartbeat is returned.
- A heartbeat response includes `{"state": "running", "progress": {"elapsed_ms": ..., "tool_calls_count": ...}}`. Do not treat this as a terminal result.
- Omit `timeout_ms` or set it to 0 to block until the run completes (only suitable when the MCP transport timeout is very high).
- Use `pi_read_result` only when the original wait connection was interrupted after the Pi run completed.
- Use `pi_get_run` for diagnostics and recovery only. It also exposes the `session_id` for the run.
- Prefer `workspace_mode: auto`; git repositories use isolated snapshot worktrees that include current tracked and untracked coordinator changes while returning only Pi's delta.
- When a result includes `workspace`, inspect changes through `workspace.status_command`, `workspace.diff_command`, `workspace.patch_path`, or the listed `changed_files`. Do not request or paste the full patch into model context unless the task specifically needs it.
- Integrate Pi work deliberately from the primary checkout by applying `workspace.patch_path`, merging `workspace.branch`, or manually porting selected files.
- Use `pi_stop` only when the user explicitly asks to cancel a Pi run.
- Use `pi_recent_tool_calls` for occasional inspection of current activity. Never use it as a status-polling loop.

## Safety

- Avoid exposing credentials or complete sensitive command arguments in Pi prompts.
- Do not paste complete secret-bearing tool arguments back to the user.
- Treat `pi_recent_tool_calls` arguments as sanitized summaries, not authoritative raw command logs.
