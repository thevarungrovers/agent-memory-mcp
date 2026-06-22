import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { MemoryEntry } from "./types.js";

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
