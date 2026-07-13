#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const marketplace = JSON.parse(fs.readFileSync(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
const marketplaceName = marketplace.name;
const selector = `pi-subagent-bridge@${marketplaceName}`;
const command = process.argv[2] ?? "install";

if (command === "--postinstall" && process.env.npm_config_global !== "true") {
  console.log("pi-subagent-bridge: run `npx pi-subagent-bridge install` to install the Codex plugin.");
  process.exit(0);
}

if (!["install", "--postinstall"].includes(command)) {
  console.error("Usage: pi-subagent-bridge [install]");
  process.exit(2);
}

if (process.env.CODEX_HOME) fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const version = run("codex", ["--version"], { optional: command === "--postinstall" });
if (!version) {
  console.log("pi-subagent-bridge: Codex was not found; after installing Codex, run `pi-subagent-bridge install`.");
  process.exit(0);
}

// Native dependencies must be loaded by the same Node ABI that npm used to
// install this package. Codex may have a different, older `node` on its PATH.
configurePluginRuntime();

// Re-adding the same local source is harmless on some Codex versions and an
// error on others. Remove only this package's named source to stay idempotent.
run("codex", ["plugin", "marketplace", "remove", marketplaceName, "--json"], { optional: true, quiet: true });
run("codex", ["plugin", "marketplace", "add", root, "--json"]);
run("codex", ["plugin", "add", selector, "--json"]);
console.log(`pi-subagent-bridge: installed ${selector}. Start a new Codex thread to load it.`);

function configurePluginRuntime() {
  const manifestPath = path.join(root, "plugins", "pi-subagent-bridge", ".mcp.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const server = manifest.mcpServers?.["pi-subagent-bridge"];
  if (!server) {
    console.error("pi-subagent-bridge: plugin MCP configuration is missing.");
    process.exit(1);
  }
  server.command = fs.realpathSync(process.execPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: "utf8", stdio: options.quiet ? "ignore" : "pipe" });
  if (result.status === 0) return result.stdout?.trim() || "ok";
  if (options.optional) return "";
  if (result.error?.code === "ENOENT") {
    console.error(`pi-subagent-bridge: required command not found: ${executable}`);
  } else {
    console.error(result.stderr?.trim() || result.stdout?.trim() || `${executable} exited with status ${result.status}`);
  }
  process.exit(result.status || 1);
}
