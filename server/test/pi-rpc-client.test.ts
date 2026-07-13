import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PiRpcClient } from "../src/pi-rpc-client.js";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.py", import.meta.url));
const temporaryDirectories: string[] = [];

afterEach(() => {
  delete process.env.FAKE_PI_EXIT_ON_MODELS;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("PiRpcClient", () => {
  it("preserves the supplied PATH instead of preferring the bridge Node", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-rpc-client-"));
    temporaryDirectories.push(directory);
    const environmentFile = path.join(directory, "environment.json");
    const suppliedPath = ["/pi-runtime/bin", process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter);
    const client = new PiRpcClient({
      executable: "python3",
      args: [fakePi],
      cwd: directory,
      env: {
        PATH: suppliedPath,
        FAKE_PI_ENV_FILE: environmentFile,
      },
    });

    try {
      await client.request("get_available_models");
      expect(JSON.parse(fs.readFileSync(environmentFile, "utf8"))).toEqual({
        cwd: directory,
        path: suppliedPath,
        agent_dir: null,
        session_dir: null,
      });
    } finally {
      client.terminate();
    }
  });

  it("includes a bounded Pi stderr tail when the RPC process exits", async () => {
    const client = new PiRpcClient({
      executable: "python3",
      args: [fakePi],
      env: { FAKE_PI_EXIT_ON_MODELS: "1" },
    });

    await expect(client.request("get_available_models")).rejects.toThrow(
      /Pi RPC process exited before response: code=7 signal=null\nstderr: intentional Pi startup failure/,
    );
  });
});
