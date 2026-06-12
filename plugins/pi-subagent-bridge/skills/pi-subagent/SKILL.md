---
name: pi-subagent
description: Use Pi coding-agent subprocesses through the bundled pi-subagent-bridge MCP server.
---

# Pi Subagent

Use this skill when the user asks Codex to delegate coding work to Pi, compare Pi models, or inspect Pi sub-agent activity.

## Workflow

- Prefer the default Pi model unless the task clearly needs a particular provider, context size, reasoning support, or input capability.
- Use `pi_list_models` only when model selection is necessary. Prefer a focused `query` such as `"gpt 5.5 reasoning"` instead of listing every model.
- Call `pi_start` once for a task. Provide the task, working directory, provider if selected, model ID if selected, and optional thinking level only when useful.
- After `pi_start`, do independent local work before waiting when that can reduce idle time.
- Call `pi_wait` exactly once for the returned `run_id`. Do not poll with repeated waits.
- Use `pi_read_result` only when the original wait connection was interrupted after the Pi run completed.
- Use `pi_get_run` for diagnostics and recovery only. It is not the normal waiting mechanism.
- Use `pi_stop` only when the user explicitly asks to cancel a Pi run.
- Use `pi_recent_tool_calls` for occasional inspection of current activity. Never use it as a status-polling loop.

## Safety

- Avoid exposing credentials or complete sensitive command arguments in Pi prompts.
- Do not paste complete secret-bearing tool arguments back to the user.
- Treat `pi_recent_tool_calls` arguments as sanitized summaries, not authoritative raw command logs.
