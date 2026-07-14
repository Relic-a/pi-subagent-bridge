import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { isAgentProfileName } from "./agent-profiles.js";
import type {
  RunEvent,
  RunEventKind,
  RunRecord,
  RunState,
  ToolCallAudit,
} from "./types.js";

export class ToolCallStore {
  private db: Database.Database;
  private maxToolCalls: number;
  private maxRuns: number;

  constructor(
    dbPath: string,
    limits?: { maxToolCalls?: number; maxRuns?: number },
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.maxToolCalls = limits?.maxToolCalls ?? 1000;
    this.maxRuns = limits?.maxRuns ?? 200;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        agent TEXT,
        provider TEXT,
        model_id TEXT,
        thinking_level TEXT,
        session_id TEXT,
        error TEXT,
        final_answer TEXT,
        workspace_json TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        run_id TEXT NOT NULL,
        pi_tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id_sequence
        ON tool_calls(run_id, sequence DESC);
      CREATE INDEX IF NOT EXISTS idx_run_events_run_id_sequence
        ON run_events(run_id, sequence DESC);
    `);
    this.ensureColumn("runs", "agent", "TEXT");
    this.ensureColumn("runs", "session_id", "TEXT");
    this.ensureColumn("runs", "workspace_json", "TEXT");
    this.migrateSchema();
  }

  createRun(
    record: Omit<RunRecord, "has_result">,
    protectedRunIds: Iterable<string> = [],
  ): RunRecord[] {
    this.db
      .prepare(
        `INSERT INTO runs
        (run_id, task, state, created_at, updated_at, working_directory, agent, provider, model_id, thinking_level, session_id, error, final_answer, workspace_json)
        VALUES (@run_id, @task, @state, @created_at, @updated_at, @working_directory, @agent, @provider, @model_id, @thinking_level, @session_id, @error, @final_answer, @workspace_json)`,
      )
      .run(normalizeRecord(record));
    return this.pruneRuns(protectedRunIds);
  }

  updateRun(
    runId: string,
    state: RunState,
    fields?: { error?: string; final_answer?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE runs
        SET state = @state, updated_at = @updated_at, error = COALESCE(@error, error),
            final_answer = COALESCE(@final_answer, final_answer)
        WHERE run_id = @run_id`,
      )
      .run({
        run_id: runId,
        state,
        updated_at: new Date().toISOString(),
        error: fields?.error,
        final_answer: fields?.final_answer,
      });
  }

  updateRunSessionId(runId: string, sessionId: string): void {
    this.db
      .prepare(
        `UPDATE runs SET session_id = COALESCE(@session_id, session_id) WHERE run_id = @run_id`,
      )
      .run({ run_id: runId, session_id: sessionId });
  }

  updateRunWorkspace(runId: string, workspace: RunRecord["workspace"]): void {
    this.db
      .prepare(
        "UPDATE runs SET workspace_json = @workspace_json WHERE run_id = @run_id",
      )
      .run({
        run_id: runId,
        workspace_json: workspace ? JSON.stringify(workspace) : null,
      });
  }

  getRun(runId: string): RunRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM runs WHERE run_id = ?")
      .get(runId) as DbRun | undefined;
    return row ? mapRun(row) : undefined;
  }

  addToolCall(entry: Omit<ToolCallAudit, "sequence">): ToolCallAudit {
    const result = this.db
      .prepare(
        `INSERT INTO tool_calls (timestamp, run_id, pi_tool_call_id, tool_name, arguments_json)
        VALUES (@timestamp, @run_id, @pi_tool_call_id, @tool_name, @arguments_json)`,
      )
      .run({
        ...entry,
        arguments_json:
          entry.arguments === undefined
            ? null
            : JSON.stringify(entry.arguments),
      });
    this.pruneToolCalls();
    return { ...entry, sequence: Number(result.lastInsertRowid) };
  }

  recentToolCalls(limit = 50, runId?: string): ToolCallAudit[] {
    const boundedLimit = Math.max(1, Math.min(limit, this.maxToolCalls));
    const rows = (
      runId
        ? this.db
            .prepare(
              "SELECT * FROM tool_calls WHERE run_id = ? ORDER BY sequence DESC LIMIT ?",
            )
            .all(runId, boundedLimit)
        : this.db
            .prepare("SELECT * FROM tool_calls ORDER BY sequence DESC LIMIT ?")
            .all(boundedLimit)
    ) as DbToolCall[];
    return rows.reverse().map((row) => ({
      sequence: row.sequence,
      timestamp: row.timestamp,
      run_id: row.run_id,
      pi_tool_call_id: row.pi_tool_call_id,
      tool_name: row.tool_name,
      arguments: row.arguments_json
        ? JSON.parse(row.arguments_json)
        : undefined,
    }));
  }

  addRunEvent(entry: Omit<RunEvent, "sequence">): RunEvent {
    const result = this.db
      .prepare(
        `INSERT INTO run_events (timestamp, run_id, kind, payload_json)
         VALUES (@timestamp, @run_id, @kind, @payload_json)`,
      )
      .run({ ...entry, payload_json: JSON.stringify(entry.payload) });
    return { ...entry, sequence: Number(result.lastInsertRowid) };
  }

  getRunEvents(runId: string, after = 0, limit = 50): RunEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 500));
    const rows = this.db
      .prepare(
        `SELECT * FROM run_events
         WHERE run_id = ? AND sequence > ?
         ORDER BY sequence ASC LIMIT ?`,
      )
      .all(runId, after, boundedLimit) as DbRunEvent[];
    return rows.map((row) => ({
      sequence: row.sequence,
      timestamp: row.timestamp,
      run_id: row.run_id,
      kind: row.kind as RunEventKind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  latestRunEvents(runId: string, limit = 8): RunEvent[] {
    const boundedLimit = Math.max(1, Math.min(limit, 50));
    const rows = this.db
      .prepare(
        `SELECT * FROM run_events WHERE run_id = ?
         ORDER BY sequence DESC LIMIT ?`,
      )
      .all(runId, boundedLimit) as DbRunEvent[];
    return rows.reverse().map((row) => ({
      sequence: row.sequence,
      timestamp: row.timestamp,
      run_id: row.run_id,
      kind: row.kind as RunEventKind,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    }));
  }

  latestRunEventSequence(runId: string): number {
    const row = this.db
      .prepare(
        "SELECT MAX(sequence) AS sequence FROM run_events WHERE run_id = ?",
      )
      .get(runId) as { sequence: number | null };
    return row.sequence ?? 0;
  }

  countToolCalls(runId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM tool_calls WHERE run_id = ?")
      .get(runId) as { count: number };
    return row.count;
  }

  close(): void {
    this.db.close();
  }

  private pruneToolCalls(): void {
    this.db
      .prepare(
        `DELETE FROM tool_calls WHERE sequence NOT IN
       (SELECT sequence FROM tool_calls ORDER BY sequence DESC LIMIT ?)`,
      )
      .run(this.maxToolCalls);
  }

  private pruneRuns(protectedRunIds: Iterable<string>): RunRecord[] {
    const protectedIds = new Set(protectedRunIds);
    const rows = this.db
      .prepare("SELECT * FROM runs ORDER BY created_at DESC")
      .all() as DbRun[];
    const candidates = rows
      .slice(this.maxRuns)
      .filter((row) => !protectedIds.has(row.run_id));
    if (candidates.length === 0) return [];
    const remove = this.db.transaction((ids: string[]) => {
      const statement = this.db.prepare("DELETE FROM runs WHERE run_id = ?");
      for (const id of ids) statement.run(id);
    });
    remove(candidates.map((row) => row.run_id));
    return candidates.map(mapRun);
  }

  private ensureColumn(table: string, column: string, type: string): void {
    const columns = this.db
      .prepare(`PRAGMA table_info(${table})`)
      .all() as Array<{ name: string }>;
    if (!columns.some((entry) => entry.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  private migrateSchema(): void {
    const foreignKeys = this.db
      .prepare("PRAGMA foreign_key_list(tool_calls)")
      .all() as Array<{ table: string; on_delete: string }>;
    if (
      !foreignKeys.some(
        (key) => key.table === "runs" && key.on_delete === "CASCADE",
      )
    ) {
      this.db.transaction(() => {
        this.db.exec(`
          ALTER TABLE tool_calls RENAME TO tool_calls_legacy;
          CREATE TABLE tool_calls (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            run_id TEXT NOT NULL,
            pi_tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            arguments_json TEXT,
            FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
          );
          INSERT INTO tool_calls
            SELECT * FROM tool_calls_legacy
            WHERE run_id IN (SELECT run_id FROM runs);
          DROP TABLE tool_calls_legacy;
        `);
      })();
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run_id_sequence
        ON tool_calls(run_id, sequence DESC);
      PRAGMA user_version = 1;
    `);
  }
}

interface DbRun {
  run_id: string;
  task: string;
  state: RunState;
  created_at: string;
  updated_at: string;
  working_directory: string;
  agent: string | null;
  provider: string | null;
  model_id: string | null;
  thinking_level: string | null;
  session_id: string | null;
  error: string | null;
  final_answer: string | null;
  workspace_json: string | null;
}

interface DbToolCall {
  sequence: number;
  timestamp: string;
  run_id: string;
  pi_tool_call_id: string;
  tool_name: string;
  arguments_json: string | null;
}

interface DbRunEvent {
  sequence: number;
  timestamp: string;
  run_id: string;
  kind: string;
  payload_json: string;
}

function normalizeRecord(
  record: Omit<RunRecord, "has_result">,
): Record<string, unknown> {
  return {
    ...record,
    agent: record.agent ?? null,
    provider: record.provider ?? null,
    model_id: record.model_id ?? null,
    thinking_level: record.thinking_level ?? null,
    session_id: record.session_id ?? null,
    error: record.error ?? null,
    final_answer: record.final_answer ?? null,
    workspace_json: record.workspace ? JSON.stringify(record.workspace) : null,
  };
}

function mapRun(row: DbRun): RunRecord {
  return {
    run_id: row.run_id,
    task: row.task,
    state: row.state,
    created_at: row.created_at,
    updated_at: row.updated_at,
    working_directory: row.working_directory,
    agent: isAgentProfileName(row.agent) ? row.agent : undefined,
    provider: row.provider ?? undefined,
    model_id: row.model_id ?? undefined,
    thinking_level: row.thinking_level ?? undefined,
    session_id: row.session_id ?? undefined,
    error: row.error ?? undefined,
    final_answer: row.final_answer ?? undefined,
    has_result: row.final_answer != null,
    workspace: row.workspace_json
      ? (JSON.parse(row.workspace_json) as RunRecord["workspace"])
      : undefined,
  };
}
