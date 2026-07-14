import type { StartRunInput } from "./types.js";

export const AGENT_PROFILE_NAMES = ["explore", "review", "implement"] as const;

export type AgentProfileName = (typeof AGENT_PROFILE_NAMES)[number];

export function isAgentProfileName(value: unknown): value is AgentProfileName {
  return (
    typeof value === "string" &&
    (AGENT_PROFILE_NAMES as readonly string[]).includes(value)
  );
}

export interface AgentModelDefaults {
  provider?: string;
  model_id?: string;
  thinking_level?: string;
}

export interface AgentProfile {
  name: AgentProfileName;
  tool_args: string[];
  workspace_mode: NonNullable<StartRunInput["workspace_mode"]>;
  model_defaults?: AgentModelDefaults;
  instructions: string[];
}

const READ_ONLY_TOOL_ARGS = [
  "--tools",
  "read,grep,find,ls",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
] as const;

export function resolveAgentProfile(
  name: AgentProfileName | undefined,
  modelDefaults: Partial<Record<AgentProfileName, AgentModelDefaults>> = {},
): AgentProfile | undefined {
  if (!name) return undefined;

  const profile = profiles[name];
  return {
    ...profile,
    tool_args: [...profile.tool_args],
    instructions: [...profile.instructions],
    model_defaults: modelDefaults[name],
  };
}

const profiles: Record<
  AgentProfileName,
  Omit<AgentProfile, "model_defaults">
> = {
  explore: {
    name: "explore",
    tool_args: [...READ_ONLY_TOOL_ARGS],
    workspace_mode: "direct",
    instructions: [
      "You are an exploration subagent.",
      "Use the repository as evidence: map relevant code, data flow, conventions, and risks without changing files.",
      "In your final answer, give concise findings with concrete file references and a recommended next action.",
    ],
  },
  review: {
    name: "review",
    tool_args: [...READ_ONLY_TOOL_ARGS],
    workspace_mode: "direct",
    instructions: [
      "You are an independent code-review subagent.",
      "Inspect the requested code or patch without changing files. Prioritize correctness, regressions, security, and missing verification.",
      "In your final answer, report actionable findings ordered by severity, each with a concrete file reference; say explicitly when no material findings remain.",
    ],
  },
  implement: {
    name: "implement",
    tool_args: ["--tools", "read,bash,edit,write,grep,find,ls"],
    workspace_mode: "worktree",
    instructions: [
      "You are an implementation subagent.",
      "Make the requested scoped changes in your isolated worktree, then verify them with the most relevant available checks.",
      "In your final answer, summarize changed files and verification only. Do not paste full diffs or patches.",
    ],
  },
};
