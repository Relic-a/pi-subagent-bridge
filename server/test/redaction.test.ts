import { describe, expect, it } from "vitest";
import { redactSecrets } from "../src/redaction.js";

describe("secret redaction", () => {
  it("redacts nested secret fields without mutating the input", () => {
    const input = {
      command: "deploy",
      nested: { authorization: "Bearer example-value", safe: "visible" },
    };

    expect(redactSecrets(input)).toEqual({
      command: "deploy",
      nested: { authorization: "[REDACTED]", safe: "visible" },
    });
    expect(input.nested.authorization).toBe("Bearer example-value");
  });

  it("redacts recognized token shapes and key-value strings", () => {
    expect(redactSecrets("token=abcdefghijklmnop secret text")).toBe(
      "token=[REDACTED] secret text",
    );
    const syntheticKey = ["sk", "1234567890abcdefghijklmnop"].join("-");
    expect(redactSecrets(syntheticKey)).toBe("[REDACTED]");
  });
});
