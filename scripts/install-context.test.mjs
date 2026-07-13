import assert from "node:assert/strict";
import test from "node:test";

import { isGlobalInstall } from "./install-context.mjs";

test("detects a global install without npm_config_global", () => {
  const calls = [];
  const globalRoot = "/opt/node/lib/node_modules";
  const packageRoot = `${globalRoot}/pi-subagent-bridge`;

  const detected = isGlobalInstall({
    packageRoot,
    execPath: "/opt/node/bin/node",
    npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
    spawn(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 0, stdout: `${globalRoot}\n` };
    },
    realpath(value) {
      return value;
    },
  });

  assert.equal(detected, true);
  assert.deepEqual(calls, [
    {
      executable: "/opt/node/bin/node",
      args: [
        "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
        "root",
        "--global",
      ],
      options: { encoding: "utf8" },
    },
  ]);
});

test("rejects local dependency installs", () => {
  assert.equal(
    isGlobalInstall({
      packageRoot: "/workspace/node_modules/pi-subagent-bridge",
      npmExecPath: "/opt/node/lib/node_modules/npm/bin/npm-cli.js",
      spawn: () => ({ status: 0, stdout: "/opt/node/lib/node_modules\n" }),
      realpath(value) {
        return value;
      },
    }),
    false,
  );
});

test("fails closed when npm lifecycle context is unavailable", () => {
  assert.equal(
    isGlobalInstall({
      packageRoot: "/opt/node/lib/node_modules/pi-subagent-bridge",
      npmExecPath: "",
    }),
    false,
  );
});
