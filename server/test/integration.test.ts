import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const serverEntry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const pythonProbe = fileURLToPath(
  new URL("./python_mcp_probe.py", import.meta.url),
);

describe("MCP server integration", () => {
  it("handshakes from a real external MCP client process", () => {
    const result = spawnSync(
      "python3",
      [pythonProbe, process.execPath, serverEntry],
      {
        cwd: "/tmp",
        encoding: "utf8",
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const response = JSON.parse(result.stdout);
    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        capabilities: { tools: {} },
        serverInfo: { name: "pi-subagent-bridge" },
      },
    });
  });

  it("starts with default state outside a read-only current directory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bridge-mcp-"));
    const readOnlyCwd = path.join(tmp, "readonly");
    const stateRoot = path.join(tmp, "state");
    fs.mkdirSync(readOnlyCwd);
    fs.chmodSync(readOnlyCwd, 0o555);
    try {
      const env = { ...process.env };
      delete env.PI_BRIDGE_DATA_DIR;
      env.PI_BRIDGE_PROBE_CWD = readOnlyCwd;
      env.PI_BRIDGE_PROBE_NO_DATA_DIR = "1";
      env.XDG_STATE_HOME = stateRoot;
      const result = spawnSync(
        "python3",
        [pythonProbe, process.execPath, serverEntry],
        {
          cwd: readOnlyCwd,
          env,
          encoding: "utf8",
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(
        fs.existsSync(
          path.join(stateRoot, "pi-subagent-bridge", "state.sqlite"),
        ),
      ).toBe(true);
    } finally {
      fs.chmodSync(readOnlyCwd, 0o755);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
