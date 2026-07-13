import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

export function isGlobalInstall({
  packageRoot,
  execPath = process.execPath,
  npmExecPath = process.env.npm_execpath,
  spawn = spawnSync,
  realpath = fs.realpathSync,
} = {}) {
  if (!packageRoot || !npmExecPath) return false;

  // Invoke npm's CLI with the Node runtime running this lifecycle script. Using
  // `npm` directly could select a different Node version through PATH.
  const result = spawn(execPath, [npmExecPath, "root", "--global"], {
    encoding: "utf8",
  });
  if (result.status !== 0 || !result.stdout?.trim()) return false;

  try {
    const globalRoot = realpath(result.stdout.trim());
    const installedRoot = realpath(packageRoot);
    return path.dirname(installedRoot) === globalRoot;
  } catch {
    return false;
  }
}
