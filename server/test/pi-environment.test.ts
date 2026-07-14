import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preparePiEnvironment } from "../src/pi-environment.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-environment-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("Pi environment", () => {
  it("reuses an existing user Pi configuration and isolates bridge sessions", () => {
    const root = temporaryDirectory();
    const home = path.join(root, "home");
    const bridgeDataDir = path.join(root, "bridge");
    const userAgentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(userAgentDir, { recursive: true });
    fs.writeFileSync(path.join(userAgentDir, "auth.json"), "{}");

    const result = preparePiEnvironment({ HOME: home }, bridgeDataDir, home);

    expect(result.agentDir).toBe(userAgentDir);
    expect(result.agentDirSource).toBe("user");
    expect(result.env.PI_CODING_AGENT_DIR).toBe(userAgentDir);
    expect(result.sessionDir).toBe(
      path.join(bridgeDataDir, "pi-agent", "sessions"),
    );
    expect(fs.statSync(result.sessionDir).isDirectory()).toBe(true);
  });

  it("falls back to an isolated agent directory when the user has no Pi configuration", () => {
    const root = temporaryDirectory();
    const home = path.join(root, "home");
    const bridgeDataDir = path.join(root, "bridge");

    const result = preparePiEnvironment({ HOME: home }, bridgeDataDir, home);

    expect(result.agentDirSource).toBe("bridge");
    expect(result.agentDir).toBe(path.join(bridgeDataDir, "pi-agent"));
    expect(fs.statSync(result.agentDir).isDirectory()).toBe(true);
  });

  it("honors explicit agent and session directory overrides", () => {
    const root = temporaryDirectory();
    const bridgeDataDir = path.join(root, "bridge");
    const agentDir = path.join(root, "custom-agent");
    const sessionDir = path.join(root, "custom-sessions");

    const result = preparePiEnvironment(
      {
        HOME: path.join(root, "home"),
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: sessionDir,
      },
      bridgeDataDir,
    );

    expect(result.agentDirSource).toBe("explicit");
    expect(result.agentDir).toBe(agentDir);
    expect(result.sessionDir).toBe(sessionDir);
  });

  it("checks the process account home when HOME does not contain Pi config", () => {
    const root = temporaryDirectory();
    const environmentHome = path.join(root, "environment-home");
    const systemHome = path.join(root, "system-home");
    const userAgentDir = path.join(systemHome, ".pi", "agent");
    fs.mkdirSync(userAgentDir, { recursive: true });

    const result = preparePiEnvironment(
      { HOME: environmentHome },
      path.join(root, "bridge"),
      systemHome,
    );

    expect(result.agentDirSource).toBe("user");
    expect(result.agentDir).toBe(userAgentDir);
  });
});
