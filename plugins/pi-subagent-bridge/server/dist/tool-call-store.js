import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
export class ToolCallStore {
    db;
    maxToolCalls;
    maxRuns;
    constructor(dbPath, limits) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.maxToolCalls = limits?.maxToolCalls ?? 1000;
        this.maxRuns = limits?.maxRuns ?? 200;
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        task TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        provider TEXT,
        model_id TEXT,
        thinking_level TEXT,
        error TEXT,
        final_answer TEXT
      );
      CREATE TABLE IF NOT EXISTS tool_calls (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        run_id TEXT NOT NULL,
        pi_tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT
      );
    `);
    }
    createRun(record) {
        this.db
            .prepare(`INSERT INTO runs
        (run_id, task, state, created_at, updated_at, working_directory, provider, model_id, thinking_level, error, final_answer)
        VALUES (@run_id, @task, @state, @created_at, @updated_at, @working_directory, @provider, @model_id, @thinking_level, @error, @final_answer)`)
            .run(normalizeRecord(record));
        this.pruneRuns();
    }
    updateRun(runId, state, fields) {
        this.db
            .prepare(`UPDATE runs
        SET state = @state, updated_at = @updated_at, error = COALESCE(@error, error),
            final_answer = COALESCE(@final_answer, final_answer)
        WHERE run_id = @run_id`)
            .run({
            run_id: runId,
            state,
            updated_at: new Date().toISOString(),
            error: fields?.error,
            final_answer: fields?.final_answer,
        });
    }
    getRun(runId) {
        const row = this.db
            .prepare("SELECT * FROM runs WHERE run_id = ?")
            .get(runId);
        return row ? mapRun(row) : undefined;
    }
    addToolCall(entry) {
        const result = this.db
            .prepare(`INSERT INTO tool_calls (timestamp, run_id, pi_tool_call_id, tool_name, arguments_json)
        VALUES (@timestamp, @run_id, @pi_tool_call_id, @tool_name, @arguments_json)`)
            .run({
            ...entry,
            arguments_json: entry.arguments === undefined
                ? null
                : JSON.stringify(entry.arguments),
        });
        this.pruneToolCalls();
        return { ...entry, sequence: Number(result.lastInsertRowid) };
    }
    recentToolCalls(limit = 50, runId) {
        const boundedLimit = Math.max(1, Math.min(limit, this.maxToolCalls));
        const rows = (runId
            ? this.db
                .prepare("SELECT * FROM tool_calls WHERE run_id = ? ORDER BY sequence DESC LIMIT ?")
                .all(runId, boundedLimit)
            : this.db
                .prepare("SELECT * FROM tool_calls ORDER BY sequence DESC LIMIT ?")
                .all(boundedLimit));
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
    close() {
        this.db.close();
    }
    pruneToolCalls() {
        this.db
            .prepare(`DELETE FROM tool_calls WHERE sequence NOT IN
       (SELECT sequence FROM tool_calls ORDER BY sequence DESC LIMIT ?)`)
            .run(this.maxToolCalls);
    }
    pruneRuns() {
        this.db
            .prepare(`DELETE FROM runs WHERE run_id NOT IN
       (SELECT run_id FROM runs ORDER BY created_at DESC LIMIT ?)`)
            .run(this.maxRuns);
    }
}
function normalizeRecord(record) {
    return {
        ...record,
        provider: record.provider ?? null,
        model_id: record.model_id ?? null,
        thinking_level: record.thinking_level ?? null,
        error: record.error ?? null,
        final_answer: record.final_answer ?? null,
    };
}
function mapRun(row) {
    return {
        run_id: row.run_id,
        task: row.task,
        state: row.state,
        created_at: row.created_at,
        updated_at: row.updated_at,
        working_directory: row.working_directory,
        provider: row.provider ?? undefined,
        model_id: row.model_id ?? undefined,
        thinking_level: row.thinking_level ?? undefined,
        error: row.error ?? undefined,
        final_answer: row.final_answer ?? undefined,
        has_result: row.final_answer != null,
    };
}
