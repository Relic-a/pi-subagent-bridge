import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listModels, normalizeModelResponse } from "../src/model-catalog.js";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.py", import.meta.url));

describe("model catalog", () => {
  it("lists structured models and supports focused search", async () => {
    const result = await listModels(
      {
        executable: "python3",
        rpcArgs: [fakePi],
        timeoutMs: 1000,
        modelListMethod: "get_available_models",
      },
      "gpt 5.5 reasoning",
    );
    expect(result.models).toHaveLength(1);
    expect(result.models[0]).toMatchObject({
      provider: "openai",
      model_id: "gpt-5.5-codex",
      reasoning_support: true,
    });
  });

  it("rejects malformed model responses", async () => {
    process.env.FAKE_PI_MALFORMED_MODELS = "1";
    await expect(
      listModels({
        executable: "python3",
        rpcArgs: [fakePi],
        timeoutMs: 1000,
        modelListMethod: "get_available_models",
      }),
    ).rejects.toThrow(/Malformed Pi model-list response/);
    delete process.env.FAKE_PI_MALFORMED_MODELS;
  });

  it("normalizes live Pi model payload fields", () => {
    const result = normalizeModelResponse({
      models: [
        {
          provider: "deepseek",
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          reasoning: true,
          input: ["text"],
          contextWindow: 1000000,
          maxTokens: 384000,
        },
      ],
    });
    expect(result).toEqual([
      {
        provider: "deepseek",
        model_id: "deepseek-v4-pro",
        display_name: "DeepSeek V4 Pro",
        reasoning_support: true,
        context_window: 1000000,
        maximum_output_tokens: 384000,
        supported_input_types: ["text"],
      },
    ]);
  });
});
