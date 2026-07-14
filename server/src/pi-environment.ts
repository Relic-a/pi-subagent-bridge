import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface PiEnvironment {
  env: NodeJS.ProcessEnv;
  agentDir: string;
  sessionDir: string;
  agentDirSource: "explicit" | "user" | "bridge";
}

/**
 * Select Pi's configuration independently from the bridge's session storage.
 *
 * Pi normally keeps authentication, provider, and model configuration in
 * ~/.pi/agent. Reusing that existing directory makes the bridge behave like
 * the user's Pi CLI. Sessions remain bridge-owned unless explicitly
 * overridden so bridge activity does not mix with interactive Pi sessions.
 */
export function preparePiEnvironment(
  env: NodeJS.ProcessEnv,
  bridgeDataDir: string,
  systemHome = os.homedir(),
): PiEnvironment {
  const explicitAgentDir = nonEmpty(env.PI_CODING_AGENT_DIR);
  const userAgentDir = explicitAgentDir
    ? undefined
    : findExistingUserAgentDir(env, systemHome);
  const agentDir = path.resolve(
    explicitAgentDir ?? userAgentDir ?? path.join(bridgeDataDir, "pi-agent"),
  );
  const sessionDir = path.resolve(
    nonEmpty(env.PI_CODING_AGENT_SESSION_DIR) ??
      path.join(bridgeDataDir, "pi-agent", "sessions"),
  );

  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });

  return {
    env: {
      ...env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
    },
    agentDir,
    sessionDir,
    agentDirSource: explicitAgentDir
      ? "explicit"
      : userAgentDir
        ? "user"
        : "bridge",
  };
}

function findExistingUserAgentDir(
  env: NodeJS.ProcessEnv,
  systemHome: string,
): string | undefined {
  const homes = [nonEmpty(env.HOME), nonEmpty(systemHome)].filter(
    (home, index, all): home is string =>
      home !== undefined && all.indexOf(home) === index,
  );
  for (const home of homes) {
    const candidate = path.resolve(home, ".pi", "agent");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      // Try the next home before falling back to bridge-owned configuration.
    }
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}
