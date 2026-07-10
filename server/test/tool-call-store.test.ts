import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ToolCallStore } from "../src/tool-call-store.js";

function record(runId: string, createdAt: string) {
  return {
    run_id: runId,
    task: "test",
    state: "completed" as const,
    created_at: createdAt,
    updated_at: createdAt,
    working_directory: "/tmp",
  };
}

describe("ToolCallStore lifecycle", () => {
  it("does not prune protected active runs and cascades tool calls", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-store-"));
    const store = new ToolCallStore(path.join(tmp, "state.sqlite"), {
      maxRuns: 1,
    });
    try {
      store.createRun(record("old-active", "2026-01-01T00:00:00.000Z"));
      store.addToolCall({
        timestamp: "2026-01-01T00:00:00.000Z",
        run_id: "old-active",
        pi_tool_call_id: "one",
        tool_name: "shell",
      });
      const pruned = store.createRun(
        record("new-run", "2026-01-02T00:00:00.000Z"),
        ["old-active", "new-run"],
      );
      expect(pruned).toEqual([]);
      expect(store.getRun("old-active")).toBeDefined();

      const later = store.createRun(
        record("newest-run", "2026-01-03T00:00:00.000Z"),
        ["newest-run"],
      );
      expect(later.map((run) => run.run_id)).toContain("old-active");
      expect(store.recentToolCalls(10, "old-active")).toEqual([]);
    } finally {
      store.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
