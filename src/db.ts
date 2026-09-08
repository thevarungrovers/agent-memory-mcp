import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryEntry, SessionLogEntry } from "./types.js";

const DATA_DIR = join(homedir(), ".agent-memory");

function resolveDataDir(): string {
  try {
    const stat = lstatSync(DATA_DIR);
    if (stat.isSymbolicLink() && !existsSync(DATA_DIR)) {
      process.stderr.write(
        `Warning: ${DATA_DIR} is a broken symlink (Google Drive unavailable). Using local storage.\n`
      );
      unlinkSync(DATA_DIR);
      mkdirSync(DATA_DIR, { recursive: true });
      return DATA_DIR;
    }
  } catch {
    // path doesn't exist yet
  }
  mkdirSync(DATA_DIR, { recursive: true });
  return DATA_DIR;
}

/**
 * Convert arbitrary free text (often an error message) into a safe FTS5 MATCH
 * query. Raw user input frequently contains FTS5 operators/special characters
 * (`()`, `:`, `-`, `*`, `"`, bareword AND/OR/NOT, column-like tokens) which
 * otherwise raise "fts5: syntax error" / "no such column" and fail the search.
 * We tokenize to alphanumerics, quote each token as a literal phrase, and OR
 * them for fuzzy recall (bm25 rank still orders by how many tokens matched).
 * Returns null when there is nothing searchable.
 */
export function toFtsQuery(input: string): string | null {
  const tokens = (input ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t}"`).join(" OR ");
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = resolveDataDir();
  const DB_PATH = join(dataDir, "memory.db");

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('bug', 'pattern', 'gotcha', 'solution', 'learning')),
      project TEXT,
      area TEXT NOT NULL,
      trigger_context TEXT,
      symptom TEXT NOT NULL,
      root_cause TEXT,
      fix TEXT NOT NULL,
      code_example TEXT,
      tags TEXT,
      severity TEXT NOT NULL DEFAULT 'major' CHECK(severity IN ('critical', 'major', 'minor', 'info')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      title,
      type,
      area,
      trigger_context,
      symptom,
      root_cause,
      fix,
      tags,
      content=memories,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, type, area, trigger_context, symptom, root_cause, fix, tags)
      VALUES (new.rowid, new.title, new.type, new.area, new.trigger_context, new.symptom, new.root_cause, new.fix, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, type, area, trigger_context, symptom, root_cause, fix, tags)
      VALUES ('delete', old.rowid, old.title, old.type, old.area, old.trigger_context, old.symptom, old.root_cause, old.fix, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, type, area, trigger_context, symptom, root_cause, fix, tags)
      VALUES ('delete', old.rowid, old.title, old.type, old.area, old.trigger_context, old.symptom, old.root_cause, old.fix, old.tags);
      INSERT INTO memories_fts(rowid, title, type, area, trigger_context, symptom, root_cause, fix, tags)
      VALUES (new.rowid, new.title, new.type, new.area, new.trigger_context, new.symptom, new.root_cause, new.fix, new.tags);
    END;
  `);

  // Daily work log. Deliberately a separate table with its own FTS index: these are
  // chronological "what did I work on" records, not reusable gotchas, and mixing them
  // into memories_fts would pollute every search_memory result. Append-only — one row
  // per session, grouped by work_date at query time, never read-modify-write.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_log (
      id TEXT PRIMARY KEY,
      work_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      project TEXT,
      summary TEXT NOT NULL,
      tags TEXT
    );

    CREATE INDEX IF NOT EXISTS session_log_work_date_idx ON session_log(work_date DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS session_log_fts USING fts5(
      summary,
      project,
      tags,
      content=session_log,
      content_rowid=rowid
    );

    CREATE TRIGGER IF NOT EXISTS session_log_ai AFTER INSERT ON session_log BEGIN
      INSERT INTO session_log_fts(rowid, summary, project, tags)
      VALUES (new.rowid, new.summary, new.project, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS session_log_ad AFTER DELETE ON session_log BEGIN
      INSERT INTO session_log_fts(session_log_fts, rowid, summary, project, tags)
      VALUES ('delete', old.rowid, old.summary, old.project, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS session_log_au AFTER UPDATE ON session_log BEGIN
      INSERT INTO session_log_fts(session_log_fts, rowid, summary, project, tags)
      VALUES ('delete', old.rowid, old.summary, old.project, old.tags);
      INSERT INTO session_log_fts(rowid, summary, project, tags)
      VALUES (new.rowid, new.summary, new.project, new.tags);
    END;
  `);
}

export function insertMemory(entry: Omit<MemoryEntry, "created_at" | "updated_at">): MemoryEntry {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memories (id, title, type, project, area, trigger_context, symptom, root_cause, fix, code_example, tags, severity)
    VALUES (:id, :title, :type, :project, :area, :trigger_context, :symptom, :root_cause, :fix, :code_example, :tags, :severity)
  `);
  stmt.run(entry);
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(entry.id) as MemoryEntry;
}

export function searchMemories(query: string, filters?: {
  area?: string;
  project?: string;
  type?: string;
  tags?: string;
  limit?: number;
}): MemoryEntry[] {
  const db = getDb();
  const limit = filters?.limit ?? 10;

  const ftsQuery = toFtsQuery(query);
  if (ftsQuery === null) return [];

  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters?.area) {
    conditions.push("m.area = :area");
    params.area = filters.area;
  }
  if (filters?.project) {
    conditions.push("m.project = :project");
    params.project = filters.project;
  }
  if (filters?.type) {
    conditions.push("m.type = :type");
    params.type = filters.type;
  }
  if (filters?.tags) {
    const tagList = filters.tags.split(",").map(t => t.trim());
    const tagConditions = tagList.map((tag, i) => {
      params[`tag${i}`] = `%${tag}%`;
      return `m.tags LIKE :tag${i}`;
    });
    conditions.push(`(${tagConditions.join(" OR ")})`);
  }

  const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT m.* FROM memories m
    JOIN memories_fts fts ON m.rowid = fts.rowid
    WHERE memories_fts MATCH :query
    ${whereClause}
    ORDER BY rank
    LIMIT :limit
  `;

  params.query = ftsQuery;
  params.limit = limit;

  return db.prepare(sql).all(params) as MemoryEntry[];
}

export function getContextMemories(areas: string[], taskDescription?: string, project?: string): MemoryEntry[] {
  const db = getDb();
  const results: MemoryEntry[] = [];

  const areaPlaceholders = areas.map((_, i) => `:area${i}`).join(", ");
  const areaParams: Record<string, string> = {};
  areas.forEach((area, i) => {
    areaParams[`area${i}`] = area;
  });

  const criticalSql = `
    SELECT * FROM memories
    WHERE area IN (${areaPlaceholders})
    AND severity IN ('critical', 'major')
    ${project ? "AND (project = :project OR project IS NULL)" : ""}
    ORDER BY severity ASC, updated_at DESC
    LIMIT 20
  `;

  const criticalParams: Record<string, string> = { ...areaParams };
  if (project) criticalParams.project = project;

  const criticalResults = db.prepare(criticalSql).all(criticalParams) as MemoryEntry[];
  results.push(...criticalResults);

  const ftsQuery = taskDescription ? toFtsQuery(taskDescription) : null;
  if (ftsQuery) {
    try {
      const ftsSql = `
        SELECT m.* FROM memories m
        JOIN memories_fts fts ON m.rowid = fts.rowid
        WHERE memories_fts MATCH :query
        ${project ? "AND (m.project = :project OR m.project IS NULL)" : ""}
        ORDER BY rank
        LIMIT 10
      `;

      const ftsParams: Record<string, string> = { query: ftsQuery };
      if (project) ftsParams.project = project;

      const ftsResults = db.prepare(ftsSql).all(ftsParams) as MemoryEntry[];
      const existingIds = new Set(results.map(r => r.id));
      for (const r of ftsResults) {
        if (!existingIds.has(r.id)) {
          results.push(r);
        }
      }
    } catch {
      // FTS query may fail on certain inputs; fall back to area-only results
    }
  }

  return results;
}

export function listMemories(filters?: {
  project?: string;
  area?: string;
  type?: string;
  severity?: string;
  limit?: number;
  offset?: number;
}): MemoryEntry[] {
  const db = getDb();
  const limit = filters?.limit ?? 20;
  const offset = filters?.offset ?? 0;

  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters?.project) {
    conditions.push("project = :project");
    params.project = filters.project;
  }
  if (filters?.area) {
    conditions.push("area = :area");
    params.area = filters.area;
  }
  if (filters?.type) {
    conditions.push("type = :type");
    params.type = filters.type;
  }
  if (filters?.severity) {
    conditions.push("severity = :severity");
    params.severity = filters.severity;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const sql = `
    SELECT * FROM memories
    ${whereClause}
    ORDER BY updated_at DESC
    LIMIT :limit OFFSET :offset
  `;

  params.limit = limit;
  params.offset = offset;

  return db.prepare(sql).all(params) as MemoryEntry[];
}

export function updateMemory(id: string, updates: Partial<Omit<MemoryEntry, "id" | "created_at">>): MemoryEntry | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryEntry | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: Record<string, string | null> = { id };

  const allowedFields = ["title", "type", "project", "area", "trigger_context", "symptom", "root_cause", "fix", "code_example", "tags", "severity"] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = :${field}`);
      params[field] = updates[field] as string | null;
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = datetime('now')");

  const sql = `UPDATE memories SET ${fields.join(", ")} WHERE id = :id`;
  db.prepare(sql).run(params);

  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryEntry;
}

export function deleteMemory(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  return result.changes > 0;
}

export function insertSessionLog(entry: {
  id: string;
  work_date: string | null;
  project: string | null;
  summary: string;
  tags: string | null;
}): SessionLogEntry {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO session_log (id, work_date, project, summary, tags)
    VALUES (:id, COALESCE(:work_date, date('now', 'localtime')), :project, :summary, :tags)
  `);
  stmt.run(entry);
  return db.prepare("SELECT * FROM session_log WHERE id = ?").get(entry.id) as SessionLogEntry;
}

/**
 * Search the daily work log. `query` is optional: with a keyword we go through
 * session_log_fts, without one we scan the base table so a bare date range still
 * answers "what did I do last week?". Ordering is chronological rather than by
 * bm25 rank (unlike searchMemories) because the caller groups by work_date, and
 * relevance ordering would interleave dates and break the grouping.
 */
export function searchSessionLog(query: string | null, filters?: {
  from?: string;
  to?: string;
  project?: string;
  limit?: number;
}): SessionLogEntry[] {
  const db = getDb();
  const limit = filters?.limit ?? 20;

  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (filters?.from) {
    conditions.push("s.work_date >= :from");
    params.from = filters.from;
  }
  if (filters?.to) {
    conditions.push("s.work_date <= :to");
    params.to = filters.to;
  }
  if (filters?.project) {
    conditions.push("s.project = :project");
    params.project = filters.project;
  }

  params.limit = limit;

  const ftsQuery = query ? toFtsQuery(query) : null;

  // A keyword that tokenizes to nothing searchable is a no-match, not "list everything".
  if (query && ftsQuery === null) return [];

  if (ftsQuery !== null) {
    params.query = ftsQuery;
    const whereClause = conditions.length > 0 ? `AND ${conditions.join(" AND ")}` : "";
    const sql = `
      SELECT s.* FROM session_log s
      JOIN session_log_fts fts ON s.rowid = fts.rowid
      WHERE session_log_fts MATCH :query
      ${whereClause}
      ORDER BY s.work_date DESC, s.created_at DESC
      LIMIT :limit
    `;
    return db.prepare(sql).all(params) as SessionLogEntry[];
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const sql = `
    SELECT s.* FROM session_log s
    ${whereClause}
    ORDER BY s.work_date DESC, s.created_at DESC
    LIMIT :limit
  `;
  return db.prepare(sql).all(params) as SessionLogEntry[];
}

export function deleteSessionLog(id: string): boolean {
  const db = getDb();
  const result = db.prepare("DELETE FROM session_log WHERE id = ?").run(id);
  return result.changes > 0;
}
