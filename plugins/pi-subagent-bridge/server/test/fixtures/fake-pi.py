#!/usr/bin/env python3
import json
import os
import signal
import sys
import threading
import time

# Parse command-line arguments for session continuation.
_session_id = None
args = sys.argv[1:]
try:
    idx = args.index("--session-id")
    _session_id = args[idx + 1]
except (ValueError, IndexError):
    try:
        idx = args.index("--session")
        _session_id = args[idx + 1]
    except (ValueError, IndexError):
        pass

args_file = os.environ.get("FAKE_PI_ARGS_FILE")
if args_file:
    with open(args_file, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(args) + "\n")
env_file = os.environ.get("FAKE_PI_ENV_FILE")
if env_file:
    with open(env_file, "w", encoding="utf-8") as fh:
        json.dump(
            {
                "cwd": os.getcwd(),
                "path": os.environ.get("PATH"),
                "agent_dir": os.environ.get("PI_CODING_AGENT_DIR"),
                "session_dir": os.environ.get("PI_CODING_AGENT_SESSION_DIR"),
            },
            fh,
        )

session_id = _session_id if _session_id else f"session-{os.getpid()}-{int(time.time() * 1000)}"
if not _session_id and os.environ.get("FAKE_PI_SUPPRESS_SESSION_RPC") == "1":
    session_id = "019ebd7c-ff7f-7d72-a11d-81e5d8d4d87c"
_session_emitted = False

aborted = False
active_timer = None

pid_file = os.environ.get("FAKE_PI_PID_FILE")
if pid_file:
    with open(pid_file, "w", encoding="utf-8") as fh:
        fh.write(str(os.getpid()))


def record_signal(name):
    signal_file = os.environ.get("FAKE_PI_SIGNAL_FILE")
    if not signal_file:
        return
    with open(signal_file, "a", encoding="utf-8") as fh:
        fh.write(name + "\n")


def handle_signal(signum, _frame):
    record_signal(signal.Signals(signum).name)
    if signum == signal.SIGTERM and os.environ.get("FAKE_PI_IGNORE_SIGTERM") == "1":
        return
    sys.exit(0)


signal.signal(signal.SIGTERM, handle_signal)
if hasattr(signal, "SIGHUP"):
    signal.signal(signal.SIGHUP, handle_signal)


def emit(value):
    print(json.dumps(value), flush=True)


def maybe_write_session_file():
    session_dir = os.environ.get("FAKE_PI_SESSION_DIR")
    if not session_dir:
        return
    project = "--" + os.getcwd().strip(os.sep).replace(os.sep, "-") + "--"
    project_dir = os.path.join(session_dir, project)
    os.makedirs(project_dir, exist_ok=True)
    file_name = f"2026-06-12T20-00-00-000Z_{session_id}.jsonl"
    with open(os.path.join(project_dir, file_name), "a", encoding="utf-8") as fh:
        fh.write(json.dumps({"type": "message"}) + "\n")


def agent_end_later(delay):
    def finish():
        if not aborted:
            emit(
                {
                    "type": "agent_end",
                    "messages": [
                        {
                            "role": "assistant",
                            "content": [
                                {"type": "text", "text": "fake final answer"}
                            ],
                        }
                    ],
                }
            )

    timer = threading.Timer(delay, finish)
    timer.start()
    return timer


def handle(message):
    global aborted, active_timer
    if message.get("type") == "get_available_models":
        if os.environ.get("FAKE_PI_EXIT_ON_MODELS") == "1":
            print("intentional Pi startup failure", file=sys.stderr, flush=True)
            os._exit(7)
        if os.environ.get("FAKE_PI_MALFORMED_MODELS") == "1":
            emit(
                {
                    "type": "response",
                    "command": "get_available_models",
                    "id": message.get("id"),
                    "success": True,
                    "data": {"nope": True},
                }
            )
            return
        emit(
            {
                "type": "response",
                "command": "get_available_models",
                "id": message.get("id"),
                "success": True,
                "data": {
                    "models": [
                        {
                            "provider": "openai",
                            "model_id": "gpt-5.5-codex",
                            "display_name": "GPT 5.5 Codex",
                            "reasoning_support": True,
                            "context_window": 400000,
                            "maximum_output_tokens": 32000,
                            "supported_input_types": ["text", "image"],
                        },
                        {
                            "provider": "anthropic",
                            "model_id": "claude-sonnet-4.5",
                            "display_name": "Claude Sonnet 4.5",
                            "reasoning_support": True,
                            "context_window": 200000,
                            "maximum_output_tokens": 16000,
                            "supported_input_types": ["text"],
                        },
                    ]
                },
            }
        )
        return

    if message.get("type") == "prompt":
        global _session_emitted
        text = message.get("message", "")
        if os.environ.get("FAKE_PI_EXIT_ON_PROMPT") == "1":
            print("intentional Pi prompt failure", file=sys.stderr, flush=True)
            os._exit(7)
        prompt_file = os.environ.get("FAKE_PI_PROMPT_FILE")
        if prompt_file:
            with open(prompt_file, "w", encoding="utf-8") as fh:
                fh.write(text)
        prompt_request_file = os.environ.get("FAKE_PI_PROMPT_REQUEST_FILE")
        if prompt_request_file:
            with open(prompt_request_file, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(message) + "\n")
        maybe_write_session_file()
        if (
            os.environ.get("FAKE_PI_SUPPRESS_SESSION_RPC") != "1"
            and not _session_emitted
            and message.get("session_signal") != "suppressed"
        ):
            was_resumed = _session_id is not None
            emit(
                {
                    "event": "session_started" if was_resumed else "session_created",
                    "params": {
                        "session_id": session_id,
                        "resumed": was_resumed,
                    },
                }
            )
            _session_emitted = True
        emit(
            {
                "type": "response",
                "command": "prompt",
                "id": message.get("id"),
                "success": True,
                "data": {}
                if os.environ.get("FAKE_PI_SUPPRESS_SESSION_RPC") == "1"
                else {"session_id": session_id},
            }
        )
        if "crash" in text:
            threading.Timer(0.02, lambda: os._exit(7)).start()
            return
        if "write workspace files" in text:
            with open("tracked.txt", "a", encoding="utf-8") as fh:
                fh.write("pi edit\n")
            with open("new-file.txt", "w", encoding="utf-8") as fh:
                fh.write("new from pi\n")
        emit(
            {
                "event": "tool_execution_start",
                "params": {
                    "tool_call_id": "tool-1",
                    "tool_name": "shell",
                    "arguments": {
                        "command": "deploy --token synthetic-test-value",
                        "password": "synthetic-password",
                    },
                },
            }
        )
        emit(
            {
                "event": "tool_execution_end",
                "params": {
                    "tool_call_id": "tool-1",
                    "result": "SECRET OUTPUT THAT MUST NOT BE STORED",
                },
            }
        )
        if "never" not in text:
            delay = int(os.environ.get("FAKE_PI_DELAY_MS", "100")) / 1000
            active_timer = agent_end_later(delay)
        return

    if message.get("type") == "abort":
        aborted = True
        abort_file = os.environ.get("FAKE_PI_ABORT_FILE")
        if abort_file:
            with open(abort_file, "a", encoding="utf-8") as fh:
                fh.write("abort\n")
        if os.environ.get("FAKE_PI_IGNORE_ABORT") == "1":
            return
        if active_timer:
            active_timer.cancel()
        threading.Timer(
            0.02, lambda: emit({"type": "agent_end", "state": "stopped"})
        ).start()


for line in sys.stdin:
    try:
        handle(json.loads(line))
    except json.JSONDecodeError:
        print("{ malformed", flush=True)

while True:
    time.sleep(1)
