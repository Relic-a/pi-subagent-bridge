import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverRuntime, findExecutable } from "../src/runtime-discovery.js";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("runtime discovery", () => {
  it("resolves Pi from PATH without changing Pi's launcher environment", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-discovery-"));
    temporaryDirectories.push(directory);
    const pi = path.join(directory, "pi");
    fs.writeFileSync(pi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const runtime = discoverRuntime({ PATH: directory, HOME: directory });

    expect(runtime.piExecutable).toBe(fs.realpathSync(pi));
    expect(runtime.piFound).toBe(true);
    expect(runtime.nodeExecutable).toBe(fs.realpathSync(process.execPath));
    expect(runtime.env.PATH).toBe(directory);
  });

  it("honors an explicit PI_EXECUTABLE path", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-discovery-"));
    temporaryDirectories.push(directory);
    const customPi = path.join(directory, "custom-pi");
    fs.writeFileSync(customPi, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const runtime = discoverRuntime({
      PATH: "",
      HOME: directory,
      PI_EXECUTABLE: customPi,
    });

    expect(runtime.piExecutable).toBe(fs.realpathSync(customPi));
    expect(runtime.piFound).toBe(true);
  });

  it("does not accept a non-executable file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-discovery-"));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, "pi"), "not executable", {
      mode: 0o644,
    });
    expect(
      findExecutable("pi", directory, { HOME: directory }),
    ).toBeUndefined();
  });
});
