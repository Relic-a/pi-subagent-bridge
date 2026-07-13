import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "pi-subagent-bridge");
const manifestPath = path.join(plugin, ".codex-plugin", "plugin.json");
const marketplacePath = path.join(root, ".agents", "plugins", "marketplace.json");
const errors = [];

const manifest = readJson(manifestPath);
const marketplace = readJson(marketplacePath);
const requiredFiles = [
  "LICENSE",
  "README.md",
  ".agents/plugins/marketplace.json",
  "plugins/pi-subagent-bridge/.codex-plugin/plugin.json",
  "plugins/pi-subagent-bridge/.mcp.json",
  "plugins/pi-subagent-bridge/server/dist/index.js",
  "plugins/pi-subagent-bridge/server/package-lock.json",
  "plugins/pi-subagent-bridge/skills/pi-subagent/SKILL.md",
];

for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(root, file))) errors.push(`missing required file: ${file}`);
}

if (manifest.name !== "pi-subagent-bridge") errors.push("manifest name must match plugin directory");
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
  errors.push("manifest version must be valid semver");
}
for (const field of ["description", "license", "homepage", "repository"]) {
  if (!manifest[field]) errors.push(`manifest missing ${field}`);
}
if (!manifest.author?.name || !manifest.interface?.developerName) errors.push("manifest missing publisher identity");
for (const component of [manifest.skills, manifest.mcpServers]) {
  if (!component || !fs.existsSync(path.resolve(plugin, component))) errors.push(`invalid component path: ${component}`);
}

const entry = marketplace.plugins?.find((candidate) => candidate.name === manifest.name);
if (!entry) errors.push("marketplace is missing the plugin entry");
if (entry?.source?.path !== "./plugins/pi-subagent-bridge") errors.push("marketplace plugin path is invalid");
if (!entry?.policy?.installation || !entry?.policy?.authentication || !entry?.category) {
  errors.push("marketplace entry is missing policy or category metadata");
}

const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
if (/\<repo-url\>|\[TODO:|Local developer/.test(readme + JSON.stringify(manifest))) {
  errors.push("release metadata contains a placeholder");
}

if (process.argv.includes("--smoke")) {
  const probe = path.join(plugin, "server", "test", "python_mcp_probe.py");
  const server = path.join(plugin, "server", "dist", "index.js");
  const result = spawnSync("python3", [probe, process.execPath, server], {
    cwd: plugin,
    encoding: "utf8",
    env: { ...process.env, PI_BRIDGE_DATA_DIR: path.join(process.env.RUNNER_TEMP ?? "/tmp", "pi-bridge-smoke") },
  });
  if (result.status !== 0) errors.push(`plugin smoke test failed: ${result.stderr || result.stdout}`);
  else {
    try {
      const response = JSON.parse(result.stdout);
      if (response.result?.serverInfo?.name !== "pi-subagent-bridge") errors.push("plugin smoke test returned the wrong server");
      if (response.result?.serverInfo?.version !== manifest.version) errors.push("plugin smoke test returned the wrong version");
    } catch {
      errors.push("plugin smoke test returned invalid JSON");
    }
  }
}

if (errors.length) {
  for (const error of errors) console.error(`error: ${error}`);
  process.exit(1);
}
console.log(`Plugin validation passed${process.argv.includes("--smoke") ? " (including smoke test)" : ""}.`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    errors.push(`cannot read ${path.relative(root, file)}: ${error.message}`);
    return {};
  }
}
