#!/usr/bin/env python3
import json
import os
import sys
import threading
import time

aborted = False
active_timer = None


def emit(value):
    print(json.dumps(value), flush=True)


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
        text = message.get("message", "")
        emit(
            {
                "type": "response",
                "command": "prompt",
                "id": message.get("id"),
                "success": True,
            }
        )
        if "crash" in text:
            threading.Timer(0.02, lambda: os._exit(7)).start()
            return
        emit(
            {
                "event": "tool_execution_start",
                "params": {
                    "tool_call_id": "tool-1",
                    "tool_name": "shell",
                    "arguments": {
                        "command": "deploy --token sk-testsecret1234567890abcdef",
                        "password": "hunter2",
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
