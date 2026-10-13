import Database from "better-sqlite3";
import { existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ArchiveReason, CurationAction, CurationRun, MemoryEntry, MemoryRelation, MemoryRevision,
  RelationKind, RuleEntry, SessionLogEntry,
} from "./types.js";

/**
 * AGENT_MEMORY_DIR overrides the storage location. It exists so the test scripts can
 * drive a throwaway database instead of the live one, and so a second machine can put
 * the store somewhere other than ~/.agent-memory without editing source.
 */
const DATA_DIR = process.env.AGENT_MEMORY_DIR
  ? resolve(process.env.AGENT_MEMORY_DIR)
  : join(homedir(), ".agent-memory");

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
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
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
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
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

  // Standing instructions ("always/never/prefer X"), as opposed to memories, which are
  // things learned. A rule is pushed into every session by the SessionStart hook rather
  // than searched for, so it needs no FTS index: there are a dozen or so, they are read
  // wholesale, and four shadow tables plus three sync triggers would buy nothing.
  // UNIQUE over (rule, project) is an expression index because SQLite treats NULLs as
  // distinct, which would otherwise let the same global rule be stored twice.
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      rule TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('always', 'never', 'prefer', 'ask')),
      project TEXT,
      area TEXT,
      rationale TEXT,
      priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('critical', 'high', 'normal')),
      active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
      tags TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS rules_unique_idx
      ON rules(rule, COALESCE(project, ''));
  `);

  migrateCuration(db);
}

/**
 * One-time conversion of stored timestamps from UTC to local time.
 *
 * Every timestamp in this database now reads as local time, because a store that mixes
 * the two is a trap with no good outcome: a date comparison is either silently wrong
 * for four hours a day, or correct only if every caller remembers a modifier that is
 * invisible when it is missing. The failure is specifically nasty for a scheduled job —
 * after 20:00 EDT the UTC date has already rolled over, so an evening query matches
 * nothing written that evening, returns no rows, and reports success.
 *
 * Runs once, guarded by a flag, and only touches rows that pre-date the change.
 * work_date is deliberately excluded: it was always a local calendar date.
 */
function migrateLocaltime(db: Database.Database): void {
  const done = db.prepare("SELECT value FROM curation_state WHERE key = 'localtime_migration'").get() as
    | { value: string }
    | undefined;
  if (done?.value === "1") return;

  const offset = db.prepare("SELECT strftime('%s','now','localtime') - strftime('%s','now') AS secs").get() as {
    secs: number;
  };

  // A zero offset (UTC machine) means the stored values are already local by definition.
  if (offset.secs !== 0) {
    db.exec(`
      UPDATE memories SET
        created_at = datetime(created_at, 'localtime'),
        updated_at = datetime(updated_at, 'localtime');
      UPDATE session_log SET created_at = datetime(created_at, 'localtime');
      UPDATE rules SET
        created_at = datetime(created_at, 'localtime'),
        updated_at = datetime(updated_at, 'localtime');
    `);
  }

  db.prepare("INSERT INTO curation_state (key, value) VALUES ('localtime_migration', '1')").run();
  process.stderr.write(
    `agent-memory: converted stored timestamps to local time (offset ${offset.secs / 3600}h)\n`
  );
}

/**
 * Catches rows a server process running the previous build wrote after the conversion.
 *
 * dist/ is loaded once per client, so an MCP server started before an upgrade keeps
 * writing UTC until that client restarts. Those rows are stamped ahead of local time,
 * which is otherwise impossible, so they are unambiguous west of Greenwich and this
 * simply never matches east of it. Cheap, bounded, and it closes the window without
 * anyone having to notice it was open.
 */
function sweepStragglerTimestamps(db: Database.Database): void {
  const offset = db.prepare("SELECT strftime('%s','now','localtime') - strftime('%s','now') AS secs").get() as {
    secs: number;
  };
  if (offset.secs >= 0) return;

  const fixed = db
    .prepare(
      `UPDATE memories SET
         created_at = datetime(created_at, 'localtime'),
         updated_at = datetime(updated_at, 'localtime')
       WHERE created_at > datetime('now', 'localtime')`
    )
    .run();
  db.prepare(
    `UPDATE rules SET
       created_at = datetime(created_at, 'localtime'),
       updated_at = datetime(updated_at, 'localtime')
     WHERE created_at > datetime('now', 'localtime')`
  ).run();
  db.prepare(
    "UPDATE session_log SET created_at = datetime(created_at, 'localtime') WHERE created_at > datetime('now', 'localtime')"
  ).run();

  if (fixed.changes > 0) {
    process.stderr.write(`agent-memory: converted ${fixed.changes} straggler timestamps to local time\n`);
  }
}

/**
 * Columns, tables and guards the nightly curator needs. Split out of migrate() only
 * for length; it is called from there and runs on every process start like the rest.
 *
 * Two things here are load-bearing and easy to get wrong later:
 *
 * 1. ADDITIVE ONLY. migrate() is a pile of CREATE TABLE IF NOT EXISTS with no version
 *    table, so a new column needs an explicit PRAGMA table_info guard. There is no
 *    down-migration and no schema version to check against.
 *
 * 2. NEVER ADD THESE TO memories_fts. It is an external-content FTS5 index keyed on
 *    rowid; changing its column list means rebuilding it. Archive state is filtered in
 *    the outer query instead (see searchMemories / getContextMemories / listMemories) —
 *    the memories_au trigger reindexes a row on every UPDATE, so an archived row still
 *    MATCHes and has to be excluded by the join, not by the index.
 */
function migrateCuration(db: Database.Database): void {
  const have = new Set(
    (db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]).map((c) => c.name)
  );
  const addColumn = (name: string, decl: string): void => {
    if (!have.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${decl}`);
  };

  // A soft delete. Archiving rather than deleting is what makes an unattended nightly
  // job acceptable: every removal stays readable and restorable.
  addColumn("archived_at", "TEXT");
  addColumn("archive_reason", "TEXT");
  addColumn("superseded_by", "TEXT");
  // When the curator last judged this row. Together with the dirty flag below it stops
  // the same memory being re-litigated every single night.
  addColumn("curated_at", "TEXT");
  addColumn("curator_edit_count", "INTEGER NOT NULL DEFAULT 0");
  // The curator appends here instead of rewriting a fact. It has no ground truth to
  // check a claim against, so it never gets to overwrite one.
  addColumn("curator_note", "TEXT");
  // Set by the human-facing write paths (store_memory / update_memory) and cleared by
  // the curator. The curator's own writes must never set it, or its edits re-enter
  // tomorrow's candidate window and the row drifts a little further every night.
  addColumn("dirty", "INTEGER NOT NULL DEFAULT 1");

  db.exec(`
    CREATE INDEX IF NOT EXISTS memories_archived_idx ON memories(archived_at);
    CREATE INDEX IF NOT EXISTS memories_dirty_idx ON memories(dirty, updated_at DESC);

    -- The "CORRECTION to [[...]]" convention, as state rather than prose. A row that is
    -- the target of a corrects/contradicts edge is archive-immune (trigger below): the
    -- pair's value IS the disagreement, and archiving either side orphans the other.
    CREATE TABLE IF NOT EXISTS memory_relations (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('supersedes', 'corrects', 'contradicts', 'duplicate_of', 'refines')),
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      created_by TEXT NOT NULL DEFAULT 'session'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS memory_relations_unique_idx ON memory_relations(from_id, to_id, kind);
    CREATE INDEX IF NOT EXISTS memory_relations_to_idx ON memory_relations(to_id);

    -- Column-level history. This is what makes an in-place edit SELECTIVELY recoverable;
    -- a whole-DB snapshot can only take you back to midnight and discards everything a
    -- real session wrote after it. Deliberately no FK: when a row is hard-deleted these
    -- rows are the only surviving record of what it said.
    CREATE TABLE IF NOT EXISTS memory_revisions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      run_id TEXT,
      column_name TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      changed_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      changed_by TEXT NOT NULL DEFAULT 'session'
    );
    CREATE INDEX IF NOT EXISTS memory_revisions_memory_idx ON memory_revisions(memory_id, changed_at DESC);
    CREATE INDEX IF NOT EXISTS memory_revisions_run_idx ON memory_revisions(run_id);

    CREATE TABLE IF NOT EXISTS curation_runs (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL CHECK(mode IN ('nightly', 'sweep')),
      started_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
      finished_at TEXT,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running', 'ok', 'failed', 'rolled_back')),
      window_from TEXT,
      window_to TEXT,
      candidates INTEGER NOT NULL DEFAULT 0,
      applied INTEGER NOT NULL DEFAULT 0,
      proposed INTEGER NOT NULL DEFAULT 0,
      notes TEXT
    );

    -- The ledger. Written inside the same transaction as the mutation it records, so a
    -- crash can never leave an action applied but unrecorded (or the reverse). The
    -- morning report's counts come from here, never from the model's own account of
    -- what it did.
    CREATE TABLE IF NOT EXISTS curation_actions (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      memory_id TEXT NOT NULL,
      verdict TEXT NOT NULL,
      tier TEXT NOT NULL CHECK(tier IN ('applied', 'proposed', 'refused')),
      reason TEXT,
      cites TEXT,
      rationale TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    );
    CREATE INDEX IF NOT EXISTS curation_actions_run_idx ON curation_actions(run_id);

    -- Small KV for the watermark and the failure latch. A failed run leaves the
    -- watermark untouched and sets last_run_failed, which blocks the next automatic
    -- run: a job that is broken should stop, not retry into the same wall nightly.
    CREATE TABLE IF NOT EXISTS curation_state (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    -- SQLite triggers cannot see who is calling, so the caller announces itself here.
    -- The curator sets actor='curator' for the length of its run; every other writer
    -- leaves it NULL and the guard triggers below stay dormant. A crashed run that
    -- never clears the row leaves the guards ON, which is the safe direction to fail.
    CREATE TABLE IF NOT EXISTS curation_session (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      actor TEXT,
      run_id TEXT,
      started_at TEXT
    );
    INSERT OR IGNORE INTO curation_session (id, actor, run_id, started_at) VALUES (1, NULL, NULL, NULL);
  `);

  migrateLocaltime(db);
  sweepStragglerTimestamps(db);

  // Column-level history, one INSERT per tracked column. Generated rather than written
  // out thirteen times by hand; SQLite trigger bodies cannot loop.
  const tracked = [
    "title", "type", "project", "area", "trigger_context", "symptom", "root_cause",
    "fix", "code_example", "tags", "severity", "archived_at", "superseded_by", "curator_note",
  ];
  const revisionInserts = tracked
    .map(
      (col) => `
      INSERT INTO memory_revisions (id, memory_id, run_id, column_name, old_value, new_value, changed_by)
      SELECT lower(hex(randomblob(16))), old.id,
             (SELECT run_id FROM curation_session WHERE id = 1),
             '${col}', old.${col}, new.${col},
             COALESCE((SELECT actor FROM curation_session WHERE id = 1), 'session')
      WHERE new.${col} IS NOT old.${col};`
    )
    .join("\n");

  db.exec(`
    DROP TRIGGER IF EXISTS memories_revision_au;
    CREATE TRIGGER memories_revision_au AFTER UPDATE ON memories BEGIN
    ${revisionInserts}
    END;
  `);

  // ---- Guard triggers. These are the rails, and they live here rather than in the
  // tool layer on purpose: no allowlist, prompt or CLI flag can route around a trigger.

  const severityRank = `CASE %s.severity WHEN 'critical' THEN 0 WHEN 'major' THEN 1 WHEN 'minor' THEN 2 ELSE 3 END`;

  db.exec(`
    DROP TRIGGER IF EXISTS memories_guard_symptom;
    -- The single highest-value rail. A memory is findable because its symptom holds the
    -- exact string a future search will match ("fatal: not a git repository", ENOTEMPTY,
    -- --repo owner/name). Normalising prose strips precisely those, and the entry still
    -- reads beautifully in the report while having become unreachable. So: append only.
    CREATE TRIGGER memories_guard_symptom BEFORE UPDATE OF symptom ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
     AND new.symptom IS NOT old.symptom
     AND instr(new.symptom, old.symptom) = 0
    BEGIN
      SELECT RAISE(ABORT, 'curator: symptom is append-only — the previous text must survive verbatim');
    END;

    DROP TRIGGER IF EXISTS memories_guard_code_example;
    CREATE TRIGGER memories_guard_code_example BEFORE UPDATE OF code_example ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
     AND old.code_example IS NOT NULL
     AND new.code_example IS NOT old.code_example
     AND instr(COALESCE(new.code_example, ''), old.code_example) = 0
    BEGIN
      SELECT RAISE(ABORT, 'curator: code_example is append-only — the previous text must survive verbatim');
    END;

    DROP TRIGGER IF EXISTS memories_guard_shrink;
    -- Blandification shows up as shrinkage before it shows up as anything else.
    CREATE TRIGGER memories_guard_shrink BEFORE UPDATE ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
     AND length(COALESCE(new.symptom, '') || COALESCE(new.root_cause, '') || COALESCE(new.fix, '')) * 10
       < length(COALESCE(old.symptom, '') || COALESCE(old.root_cause, '') || COALESCE(old.fix, '')) * 8
    BEGIN
      SELECT RAISE(ABORT, 'curator: refusing an edit that cuts more than 20% of the prose');
    END;

    DROP TRIGGER IF EXISTS memories_guard_severity;
    -- Without this, "never archive a critical row" is defeated in two steps: downgrade
    -- it tonight, archive it tomorrow.
    CREATE TRIGGER memories_guard_severity BEFORE UPDATE OF severity ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
     AND (${severityRank.replace("%s", "new")}) > (${severityRank.replace("%s", "old")})
    BEGIN
      SELECT RAISE(ABORT, 'curator: severity downgrades are not permitted');
    END;

    DROP TRIGGER IF EXISTS memories_guard_edit_count;
    -- The backstop against compounding drift, and it holds even if the dirty-flag
    -- selection logic is wrong: after two curator touches the row is frozen until a
    -- human edits it (which resets the count — see updateMemory).
    CREATE TRIGGER memories_guard_edit_count BEFORE UPDATE ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
     AND old.curator_edit_count >= 2
     AND (new.title IS NOT old.title OR new.symptom IS NOT old.symptom
       OR new.root_cause IS NOT old.root_cause OR new.fix IS NOT old.fix
       OR new.code_example IS NOT old.code_example OR new.tags IS NOT old.tags)
    BEGIN
      SELECT RAISE(ABORT, 'curator: this memory has already been curated twice and is frozen until a human edits it');
    END;

    DROP TRIGGER IF EXISTS memories_guard_archive_immune;
    CREATE TRIGGER memories_guard_archive_immune BEFORE UPDATE OF archived_at ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
     AND new.archived_at IS NOT NULL AND old.archived_at IS NULL
     AND EXISTS (SELECT 1 FROM memory_relations r WHERE r.to_id = old.id AND r.kind IN ('corrects', 'contradicts'))
    BEGIN
      SELECT RAISE(ABORT, 'curator: this memory is corrected/contradicted by another and cannot be archived — the pair is the content');
    END;

    DROP TRIGGER IF EXISTS memories_guard_delete;
    -- The curator archives; it never deletes. Hard delete stays available to a human.
    CREATE TRIGGER memories_guard_delete BEFORE DELETE ON memories
    WHEN (SELECT actor FROM curation_session WHERE id = 1) = 'curator'
    BEGIN
      SELECT RAISE(ABORT, 'curator: hard delete is not permitted — archive instead');
    END;
  `);
}

/** The columns a caller actually supplies; everything else is defaulted by the schema. */
export type NewMemory = Pick<
  MemoryEntry,
  "id" | "title" | "type" | "project" | "area" | "trigger_context" | "symptom" | "root_cause" | "fix" | "code_example" | "tags" | "severity"
>;

export function insertMemory(entry: NewMemory): MemoryEntry {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO memories (id, title, type, project, area, trigger_context, symptom, root_cause, fix, code_example, tags, severity)
    VALUES (:id, :title, :type, :project, :area, :trigger_context, :symptom, :root_cause, :fix, :code_example, :tags, :severity)
  `);
  stmt.run(entry);
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(entry.id) as MemoryEntry;
}

/**
 * Full body of one memory, archived or not.
 *
 * Deliberately unfiltered on archived_at: the archive is a soft delete, so the one
 * way back to an archived row — to read it, judge it, restore it — has to stay open.
 * Every *search* path filters; this, the by-id path, does not.
 */
export function getMemoryById(id: string): MemoryEntry | null {
  const db = getDb();
  return (db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryEntry | undefined) ?? null;
}

export function searchMemories(query: string, filters?: {
  area?: string;
  project?: string;
  type?: string;
  tags?: string;
  limit?: number;
  include_archived?: boolean;
  exclude_id?: string;
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
  if (filters?.exclude_id) {
    conditions.push("m.id != :exclude_id");
    params.exclude_id = filters.exclude_id;
  }
  if (filters?.tags) {
    const tagList = filters.tags.split(",").map(t => t.trim());
    const tagConditions = tagList.map((tag, i) => {
      params[`tag${i}`] = `%${tag}%`;
      return `m.tags LIKE :tag${i}`;
    });
    conditions.push(`(${tagConditions.join(" OR ")})`);
  }

  // Archived rows are still in the FTS index — memories_au reindexes on every UPDATE,
  // and archiving is an UPDATE — so they MATCH and have to be excluded by the join.
  if (!filters?.include_archived) conditions.push("m.archived_at IS NULL");

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
    AND archived_at IS NULL
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
        AND m.archived_at IS NULL
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
  since?: string;
  until?: string;
  include_archived?: boolean;
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
  // Columns are stored in local time (see migrateLocaltime), so these compare directly.
  // Do NOT wrap them in date(col,'localtime') — that would shift an already-local value
  // a second time. The whole store is local; there is no UTC left to convert from.
  if (filters?.since) {
    conditions.push("date(updated_at) >= :since");
    params.since = filters.since;
  }
  if (filters?.until) {
    conditions.push("date(updated_at) <= :until");
    params.until = filters.until;
  }
  if (!filters?.include_archived) conditions.push("archived_at IS NULL");

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

export function updateMemory(
  id: string,
  updates: Partial<Omit<MemoryEntry, "id" | "created_at">>,
  actor: "session" | "curator" = "session"
): MemoryEntry | null {
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

  if (actor === "curator") {
    // Deliberately NOT updated_at. The candidate window keys off recency, so a curator
    // write that bumped it would re-enter tomorrow's window, be re-read as ground truth
    // and rewritten again — the row drifting further from what a human wrote every night.
    fields.push("curated_at = datetime('now', 'localtime')");
    fields.push("curator_edit_count = curator_edit_count + 1");
  } else {
    fields.push("updated_at = datetime('now', 'localtime')");
    // A human touched it, so it is a fresh candidate again and the two-edit freeze lifts.
    fields.push("dirty = 1");
    fields.push("curator_edit_count = 0");
  }

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

/** critical first, then high, then normal; stable by age within a band. */
const RULE_ORDER = `ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, created_at ASC`;

/**
 * Returns null when an identical rule already exists for the same scope, rather
 * than throwing: re-stating a rule you already hold is a no-op worth reporting,
 * not an error worth failing the turn over.
 */
export function insertRule(entry: {
  id: string;
  rule: string;
  mode: string;
  project: string | null;
  area: string | null;
  rationale: string | null;
  priority: string;
  tags: string | null;
}): RuleEntry | null {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO rules (id, rule, mode, project, area, rationale, priority, tags)
      VALUES (:id, :rule, :mode, :project, :area, :rationale, :priority, :tags)
    `).run(entry);
  } catch (error) {
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return null;
    throw error;
  }
  return db.prepare("SELECT * FROM rules WHERE id = ?").get(entry.id) as RuleEntry;
}

/**
 * The rules that apply right now: every active global rule, plus the active rules
 * for this project. This is the one read the SessionStart hook and get_context both
 * go through, so "what is in force" has a single definition.
 */
export function getActiveRules(project?: string | null): RuleEntry[] {
  const db = getDb();
  const sql = `
    SELECT * FROM rules
    WHERE active = 1
    ${project ? "AND (project = :project OR project IS NULL)" : "AND project IS NULL"}
    ${RULE_ORDER}
  `;
  const params = project ? { project } : {};
  return db.prepare(sql).all(params) as RuleEntry[];
}

export function listRules(filters?: {
  project?: string;
  area?: string;
  mode?: string;
  priority?: string;
  include_inactive?: boolean;
  limit?: number;
}): RuleEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: Record<string, string | number> = {};

  if (!filters?.include_inactive) {
    conditions.push("active = 1");
  }
  if (filters?.project) {
    conditions.push("(project = :project OR project IS NULL)");
    params.project = filters.project;
  }
  if (filters?.area) {
    conditions.push("area = :area");
    params.area = filters.area;
  }
  if (filters?.mode) {
    conditions.push("mode = :mode");
    params.mode = filters.mode;
  }
  if (filters?.priority) {
    conditions.push("priority = :priority");
    params.priority = filters.priority;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  params.limit = filters?.limit ?? 100;

  return db.prepare(`
    SELECT * FROM rules
    ${whereClause}
    ${RULE_ORDER}
    LIMIT :limit
  `).all(params) as RuleEntry[];
}

export function updateRule(id: string, updates: Partial<Omit<RuleEntry, "id" | "created_at">>): RuleEntry | null {
  const db = getDb();
  const existing = db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleEntry | undefined;
  if (!existing) return null;

  const fields: string[] = [];
  const params: Record<string, string | number | null> = { id };

  const allowedFields = ["rule", "mode", "project", "area", "rationale", "priority", "active", "tags"] as const;

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      fields.push(`${field} = :${field}`);
      params[field] = updates[field] as string | number | null;
    }
  }

  if (fields.length === 0) return existing;

  fields.push("updated_at = datetime('now', 'localtime')");
  db.prepare(`UPDATE rules SET ${fields.join(", ")} WHERE id = :id`).run(params);

  return db.prepare("SELECT * FROM rules WHERE id = ?").get(id) as RuleEntry;
}

export function deleteRule(id: string): boolean {
  const db = getDb();
  return db.prepare("DELETE FROM rules WHERE id = ?").run(id).changes > 0;
}

// ---------------------------------------------------------------------------
// Curation
//
// Everything the nightly curator needs, kept here with the rest of the SQL. The
// division of labour that matters: the model decides, this layer applies, and the
// guard triggers in migrateCuration() refuse anything the model should not be able
// to do regardless of how it was asked.
// ---------------------------------------------------------------------------

function uuid(): string {
  return randomUUID();
}

/**
 * Announce the caller to the guard triggers, which cannot otherwise tell who is
 * writing. Held for the length of a curation run and cleared in a finally block.
 * A crashed run leaves it set, which leaves the guards ON — the safe way to fail.
 */
export function setCurationActor(actor: string | null, runId: string | null): void {
  getDb()
    .prepare("UPDATE curation_session SET actor = ?, run_id = ?, started_at = datetime('now', 'localtime') WHERE id = 1")
    .run(actor, runId);
}

export function getCurationActor(): { actor: string | null; run_id: string | null } {
  return getDb()
    .prepare("SELECT actor, run_id FROM curation_session WHERE id = 1")
    .get() as { actor: string | null; run_id: string | null };
}

/**
 * Rows worth looking at tonight: touched by something other than the curator since
 * the last run, and not already frozen. `dirty` rather than a bare timestamp window
 * is what keeps the curator's own edits out of its next input.
 */
export function listCurationCandidates(filters: {
  since?: string;
  until?: string;
  area?: string;
  limit?: number;
  includeClean?: boolean;
}): MemoryEntry[] {
  const db = getDb();
  const conditions = ["archived_at IS NULL", "curator_edit_count < 2"];
  const params: Record<string, string | number> = {};

  if (!filters.includeClean) conditions.push("dirty = 1");
  if (filters.since) {
    conditions.push("date(updated_at) >= :since");
    params.since = filters.since;
  }
  if (filters.until) {
    conditions.push("date(updated_at) <= :until");
    params.until = filters.until;
  }
  if (filters.area) {
    conditions.push("area = :area");
    params.area = filters.area;
  }
  params.limit = filters.limit ?? 25;

  return db
    .prepare(`SELECT * FROM memories WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT :limit`)
    .all(params) as MemoryEntry[];
}

export function listAreas(): { area: string; n: number }[] {
  return getDb()
    .prepare("SELECT area, COUNT(*) n FROM memories WHERE archived_at IS NULL GROUP BY area ORDER BY n DESC")
    .all() as { area: string; n: number }[];
}

export function archiveMemory(
  id: string,
  reason: ArchiveReason,
  supersededBy: string | null,
  actor: "session" | "curator" = "session"
): MemoryEntry | null {
  const db = getDb();
  const existing = getMemoryById(id);
  if (!existing || existing.archived_at) return null;

  const extra = actor === "curator" ? ", curated_at = datetime('now', 'localtime')" : ", updated_at = datetime('now', 'localtime')";
  db.prepare(
    `UPDATE memories SET archived_at = datetime('now', 'localtime'), archive_reason = :reason,
     superseded_by = COALESCE(:superseded_by, superseded_by)${extra} WHERE id = :id`
  ).run({ id, reason, superseded_by: supersededBy });

  return getMemoryById(id);
}

export function restoreMemory(id: string): MemoryEntry | null {
  const db = getDb();
  const existing = getMemoryById(id);
  if (!existing || !existing.archived_at) return null;
  db.prepare(
    `UPDATE memories SET archived_at = NULL, archive_reason = NULL,
     updated_at = datetime('now', 'localtime'), dirty = 1, curator_edit_count = 0 WHERE id = ?`
  ).run(id);
  return getMemoryById(id);
}

export function addRelation(
  fromId: string,
  toId: string,
  kind: RelationKind,
  note: string | null,
  createdBy = "session"
): MemoryRelation | null {
  const db = getDb();
  const id = uuid();
  try {
    db.prepare(
      `INSERT INTO memory_relations (id, from_id, to_id, kind, note, created_by)
       VALUES (:id, :from_id, :to_id, :kind, :note, :created_by)`
    ).run({ id, from_id: fromId, to_id: toId, kind, note, created_by: createdBy });
  } catch (error) {
    // Re-stating a relation you already hold is a no-op worth reporting, not a failure.
    if ((error as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") return null;
    throw error;
  }
  return db.prepare("SELECT * FROM memory_relations WHERE id = ?").get(id) as MemoryRelation;
}

export function getRelations(memoryId: string): MemoryRelation[] {
  return getDb()
    .prepare("SELECT * FROM memory_relations WHERE from_id = ? OR to_id = ? ORDER BY created_at")
    .all(memoryId, memoryId) as MemoryRelation[];
}

export function markCurated(id: string): void {
  getDb().prepare("UPDATE memories SET curated_at = datetime('now', 'localtime'), dirty = 0 WHERE id = ?").run(id);
}

// ---- Run bookkeeping. The report's numbers come from these rows, never from the
// model's own account of what it did: a run that died after four of nine clusters can
// still narrate a confident summary.

export function startCurationRun(mode: "nightly" | "sweep", from: string | null, to: string | null): string {
  const id = uuid();
  getDb()
    .prepare(`INSERT INTO curation_runs (id, mode, window_from, window_to) VALUES (?, ?, ?, ?)`)
    .run(id, mode, from, to);
  return id;
}

export function finishCurationRun(
  runId: string,
  status: "ok" | "failed" | "rolled_back",
  counts: { candidates?: number; applied?: number; proposed?: number; notes?: string }
): void {
  getDb()
    .prepare(
      `UPDATE curation_runs SET finished_at = datetime('now', 'localtime'), status = :status,
       candidates = :candidates, applied = :applied, proposed = :proposed, notes = :notes WHERE id = :id`
    )
    .run({
      id: runId,
      status,
      candidates: counts.candidates ?? 0,
      applied: counts.applied ?? 0,
      proposed: counts.proposed ?? 0,
      notes: counts.notes ?? null,
    });
}

export function recordCurationAction(action: {
  run_id: string;
  memory_id: string;
  verdict: string;
  tier: "applied" | "proposed" | "refused";
  reason?: string | null;
  cites?: string | null;
  rationale?: string | null;
}): string {
  const id = uuid();
  getDb()
    .prepare(
      `INSERT INTO curation_actions (id, run_id, memory_id, verdict, tier, reason, cites, rationale)
       VALUES (:id, :run_id, :memory_id, :verdict, :tier, :reason, :cites, :rationale)`
    )
    .run({
      id,
      run_id: action.run_id,
      memory_id: action.memory_id,
      verdict: action.verdict,
      tier: action.tier,
      reason: action.reason ?? null,
      cites: action.cites ?? null,
      rationale: action.rationale ?? null,
    });
  return id;
}

export function getCurationRun(runId: string): CurationRun | null {
  return (getDb().prepare("SELECT * FROM curation_runs WHERE id = ?").get(runId) as CurationRun | undefined) ?? null;
}

export function getCurationActions(runId: string): CurationAction[] {
  return getDb()
    .prepare("SELECT * FROM curation_actions WHERE run_id = ? ORDER BY created_at")
    .all(runId) as CurationAction[];
}

export function getRevisionsForRun(runId: string): MemoryRevision[] {
  return getDb()
    .prepare("SELECT * FROM memory_revisions WHERE run_id = ? ORDER BY changed_at")
    .all(runId) as MemoryRevision[];
}

export function getState(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM curation_state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string | null): void {
  if (value === null) {
    getDb().prepare("DELETE FROM curation_state WHERE key = ?").run(key);
    return;
  }
  getDb()
    .prepare(
      "INSERT INTO curation_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    )
    .run(key, value);
}

export function memoryStats(): {
  active: number;
  archived: number;
  dirty: number;
  prose_bytes: number;
  areas: number;
  oldest: string | null;
  newest: string | null;
} {
  return getDb()
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END), 0) active,
         COALESCE(SUM(CASE WHEN archived_at IS NOT NULL THEN 1 ELSE 0 END), 0) archived,
         COALESCE(SUM(CASE WHEN archived_at IS NULL AND dirty = 1 THEN 1 ELSE 0 END), 0) dirty,
         COALESCE(SUM(CASE WHEN archived_at IS NULL THEN
           length(COALESCE(symptom,'')) + length(COALESCE(root_cause,'')) + length(COALESCE(fix,''))
           + length(COALESCE(code_example,'')) + length(COALESCE(trigger_context,'')) ELSE 0 END), 0) prose_bytes,
         COUNT(DISTINCT CASE WHEN archived_at IS NULL THEN area END) areas,
         MIN(date(created_at)) oldest,
         MAX(date(created_at)) newest
       FROM memories`
    )
    .get() as ReturnType<typeof memoryStats>;
}

/**
 * A consistent copy of a live WAL database.
 *
 * VACUUM INTO, never `cp`: with a non-empty -wal a plain file copy gives you a torn or
 * stale database. And never a bare VACUUM on the live file — `id` is a TEXT primary key
 * so rowids are implicit and NOT stable across a vacuum, while memories_fts is an
 * external-content index keyed on exactly those rowids. One VACUUM silently scrambles
 * every FTS-to-row mapping, and nothing reports it.
 */
export function snapshotTo(path: string): void {
  getDb().prepare("VACUUM INTO ?").run(path);
}

export function ftsIntegrityCheck(): { ok: boolean; error?: string } {
  try {
    getDb().exec("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

export function rebuildFts(): void {
  getDb().exec("INSERT INTO memories_fts(memories_fts) VALUES('rebuild')");
}

/** Undo one run, column by column, newest change first. */
export function revertRun(runId: string): { reverted: string[]; skipped: { id: string; why: string }[] } {
  const db = getDb();
  const run = getCurationRun(runId);
  if (!run) throw new Error(`no such curation run: ${runId}`);

  const revisions = db
    .prepare("SELECT * FROM memory_revisions WHERE run_id = ? ORDER BY changed_at DESC")
    .all(runId) as MemoryRevision[];

  const reverted: string[] = [];
  const skipped: { id: string; why: string }[] = [];
  const seen = new Set<string>();

  const tx = db.transaction(() => {
    for (const rev of revisions) {
      const current = getMemoryById(rev.memory_id);
      if (!current) {
        skipped.push({ id: rev.memory_id, why: "row no longer exists" });
        continue;
      }
      // A real session edited this row after the bad night. Reverting would clobber a
      // human's work — exactly what a blind snapshot restore does silently.
      if (run.finished_at && current.updated_at > run.finished_at) {
        if (!seen.has(rev.memory_id)) skipped.push({ id: rev.memory_id, why: "edited by a session after the run" });
        seen.add(rev.memory_id);
        continue;
      }
      db.prepare(`UPDATE memories SET ${rev.column_name} = ? WHERE id = ?`).run(rev.old_value, rev.memory_id);
      if (!reverted.includes(rev.memory_id)) reverted.push(rev.memory_id);
    }
    db.prepare("UPDATE curation_runs SET status = 'rolled_back' WHERE id = ?").run(runId);
  });
  tx();

  // Any row-level restore leaves the external-content index stale.
  rebuildFts();
  return { reverted, skipped };
}
