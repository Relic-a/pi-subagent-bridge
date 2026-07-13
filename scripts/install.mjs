#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { isGlobalInstall } from "./install-context.mjs";
import { discoverRuntime } from "../plugins/pi-subagent-bridge/server/dist/runtime-discovery.js";

const root = path.resolve(import.meta.dirname, "..");
const marketplace = JSON.parse(
  fs.readFileSync(
    path.join(root, ".agents", "plugins", "marketplace.json"),
    "utf8",
  ),
);
const marketplaceName = marketplace.name;
const selector = `pi-subagent-bridge@${marketplaceName}`;
const command = process.argv[2] ?? "install";

try {
  install();
} catch (error) {
  console.error(
    `pi-subagent-bridge: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}

function install() {
  if (command === "--postinstall" && !isGlobalInstall({ packageRoot: root })) {
    console.log(
      "pi-subagent-bridge: run `npx pi-subagent-bridge install` to install the Codex plugin.",
    );
    return;
  }

  if (!["install", "--postinstall"].includes(command)) {
    throw new Error("Usage: pi-subagent-bridge [install]");
  }

  if (process.env.CODEX_HOME)
    fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

  const version = run("codex", ["--version"], {
    optional: command === "--postinstall",
  });
  if (!version) {
    console.log(
      "pi-subagent-bridge: Codex was not found; after installing Codex, run `pi-subagent-bridge install`.",
    );
    return;
  }

  reportPi();
  configurePluginRuntime();
  installMarketplace();
  console.log(
    `pi-subagent-bridge: installed ${selector}. Start a new Codex thread to load it.`,
  );
}

function reportPi() {
  const runtime = discoverRuntime();
  if (runtime.piFound) {
    console.log(`pi-subagent-bridge: Pi executable: ${runtime.piExecutable}`);
    return;
  }
  console.warn(
    "pi-subagent-bridge: Pi was not found. Install it with `npm install --global @earendil-works/pi-coding-agent` or set PI_EXECUTABLE, then run `pi-subagent-bridge install`.",
  );
}

function installMarketplace() {
  const previousSource = marketplaceSource();
  try {
    run(
      "codex",
      ["plugin", "marketplace", "remove", marketplaceName, "--json"],
      {
        optional: true,
        quiet: true,
      },
    );
    run("codex", ["plugin", "marketplace", "add", root, "--json"]);
    run("codex", ["plugin", "add", selector, "--json"]);
  } catch (error) {
    restoreMarketplace(previousSource);
    throw error;
  }
}

function marketplaceSource() {
  const output = run("codex", ["plugin", "marketplace", "list", "--json"], {
    optional: true,
  });
  if (!output) return undefined;
  try {
    const marketplace = JSON.parse(output).marketplaces?.find(
      (entry) => entry.name === marketplaceName,
    );
    return marketplace?.marketplaceSource?.source ?? marketplace?.root;
  } catch {
    return undefined;
  }
}

function restoreMarketplace(source) {
  if (!source) return;
  run("codex", ["plugin", "marketplace", "remove", marketplaceName, "--json"], {
    optional: true,
    quiet: true,
  });
  run("codex", ["plugin", "marketplace", "add", source, "--json"], {
    optional: true,
  });
  run("codex", ["plugin", "add", selector, "--json"], { optional: true });
}

function configurePluginRuntime() {
  const pluginRoot = path.join(root, "plugins", "pi-subagent-bridge");
  const manifestPath = path.join(pluginRoot, ".mcp.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const server = manifest.mcpServers?.["pi-subagent-bridge"];
  if (!server) {
    console.error("pi-subagent-bridge: plugin MCP configuration is missing.");
    process.exit(1);
  }

  // Codex resolves relative command arguments from the active workspace, not
  // from the installed plugin. Resolve both executables while this package is
  // installed so the copied plugin configuration remains self-contained.
  server.command = fs.realpathSync(process.execPath);
  server.args = [
    fs.realpathSync(path.join(pluginRoot, "server", "dist", "index.js")),
  ];
  delete server.cwd;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    stdio: options.quiet ? "ignore" : "pipe",
  });
  if (result.status === 0) return result.stdout?.trim() || "ok";
  if (options.optional) return "";
  if (result.error?.code === "ENOENT")
    throw new Error(`required command not found: ${executable}`);
  throw new Error(
    result.stderr?.trim() ||
      result.stdout?.trim() ||
      `${executable} exited with status ${result.status}`,
  );
}
