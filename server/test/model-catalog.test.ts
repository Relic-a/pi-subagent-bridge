import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { listModels } from "../src/model-catalog.js";

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
});
