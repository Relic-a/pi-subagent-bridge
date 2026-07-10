import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "pi-subagent-bridge");
const check = process.argv.includes("--check");
const entries = ["server/src", "server/test", "server/dist", "server/package.json", "server/package-lock.json", "server/tsconfig.json", "skills"];

let drift = false;
for (const entry of entries) {
  const source = path.join(root, entry);
  const target = path.join(plugin, entry);
  if (check) {
    if (!same(source, target)) {
      console.error(`plugin drift: ${entry}`);
      drift = true;
    }
    continue;
  }
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
}
if (drift) process.exitCode = 1;

function same(left, right) {
  if (!fs.existsSync(left) || !fs.existsSync(right)) return false;
  const a = fs.statSync(left);
  const b = fs.statSync(right);
  if (a.isDirectory() !== b.isDirectory()) return false;
  if (!a.isDirectory()) return fs.readFileSync(left).equals(fs.readFileSync(right));
  const leftNames = fs.readdirSync(left).sort();
  const rightNames = fs.readdirSync(right).sort();
  return leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index] && same(path.join(left, name), path.join(right, name)));
}
