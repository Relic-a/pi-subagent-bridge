#!/usr/bin/env node
import fs from "node:fs";

let aborted = false;
let activeTimer;
let buffer = "";
process.stdin.resume();
setInterval(() => {}, 1000);

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    handleLine(line);
  }
});

function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.log("{ malformed");
    return;
  }
  if (message.type === "get_available_models") {
    if (process.env.FAKE_PI_MALFORMED_MODELS === "1") {
      console.log(JSON.stringify({ type: "response", command: "get_available_models", id: message.id, success: true, data: { nope: true } }));
      return;
    }
    console.log(
      JSON.stringify({
        type: "response",
        command: "get_available_models",
        id: message.id,
        success: true,
        data: {
          models: [
            {
              provider: "openai",
              model_id: "gpt-5.5-codex",
              display_name: "GPT 5.5 Codex",
              reasoning_support: true,
              context_window: 400000,
              maximum_output_tokens: 32000,
              supported_input_types: ["text", "image"],
            },
            {
              provider: "anthropic",
              model_id: "claude-sonnet-4.5",
              display_name: "Claude Sonnet 4.5",
              reasoning_support: true,
              context_window: 200000,
              maximum_output_tokens: 16000,
              supported_input_types: ["text"],
            },
          ],
        },
      }),
    );
    return;
  }
  if (message.type === "prompt") {
    console.log(JSON.stringify({ type: "response", command: "prompt", id: message.id, success: true }));
    if (message.message.includes("crash")) {
      setTimeout(() => process.exit(7), 20);
      return;
    }
    console.log(
      JSON.stringify({
        event: "tool_execution_start",
        params: {
          tool_call_id: "tool-1",
          tool_name: "shell",
          arguments: { command: "deploy --token sk-testsecret1234567890abcdef", password: "hunter2" },
        },
      }),
    );
    console.log(
      JSON.stringify({
        event: "tool_execution_end",
        params: { tool_call_id: "tool-1", result: "SECRET OUTPUT THAT MUST NOT BE STORED" },
      }),
    );
    if (message.message.includes("never")) return;
    activeTimer = setTimeout(() => {
      if (!aborted) {
        console.log(
          JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "fake final answer" }] }] }),
        );
      }
    }, Number(process.env.FAKE_PI_DELAY_MS ?? 100));
    return;
  }
  if (message.type === "abort") {
    aborted = true;
    if (process.env.FAKE_PI_ABORT_FILE) {
      fs.appendFileSync(process.env.FAKE_PI_ABORT_FILE, "abort\n");
    }
    if (process.env.FAKE_PI_IGNORE_ABORT === "1") return;
    if (activeTimer) clearTimeout(activeTimer);
    setTimeout(() => console.log(JSON.stringify({ type: "agent_end", state: "stopped" })), 20);
  }
}
