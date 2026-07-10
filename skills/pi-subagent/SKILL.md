---
name: pi-subagent
description: Use Pi coding-agent subprocesses when the user explicitly requests Pi or requests a model unavailable through the host's built-in delegation tools.
---

# Pi Subagent

## Routing

The host's built-in delegation system is the default. Do not use Pi
for ordinary task decomposition, parallel work, or coding delegation merely
because Pi is available.

Use this skill only when one of these conditions is true:

- The user explicitly asks to use Pi, the Pi subagent, the Pi bridge, or a Pi
  tool/session.
- The user explicitly requests a model that is not available through the host's
  built-in subagent system. Use Pi to access that model.

If neither condition applies, use the host's built-in delegation system instead.
If it is unclear whether a requested model is available to the host's built-in
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
- Use `workspace_mode: direct` only when isolation is unavailable or the user explicitly wants Pi to edit the primary checkout.
- When a result includes `workspace`, inspect changes through `workspace.status_command`, `workspace.diff_command`, `workspace.patch_path`, or the listed `changed_files`. Do not request or paste the full patch into model context unless the task specifically needs it.
- Integrate Pi work deliberately from the primary checkout by applying `workspace.patch_path`, merging `workspace.branch`, or manually porting selected files.
- Prefer `pi_apply_changes` for a checked patch application; use `dry_run: true` when only conflict validation is wanted. After applying or rejecting the result, call `pi_discard_workspace` unless the branch is intentionally retained for review.
- Use `pi_doctor` when Pi cannot start, model discovery fails, or bridge configuration is suspect; it checks the executable, RPC model listing, state directory, allowed roots, and git.
- Use `pi_stop` only when the user explicitly asks to cancel a Pi run.
- Use `pi_recent_tool_calls` for occasional inspection of current activity. Never use it as a status-polling loop.

## Safety

- Avoid exposing credentials or complete sensitive command arguments in Pi prompts.
- Do not paste complete secret-bearing tool arguments back to the user.
- Treat `pi_recent_tool_calls` arguments as sanitized summaries, not authoritative raw command logs.
