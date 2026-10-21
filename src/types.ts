export interface MemoryEntry {
  id: string;
  title: string;
  type: MemoryType;
  project: string | null;
  area: string;
  trigger_context: string | null;
  symptom: string;
  root_cause: string | null;
  fix: string;
  code_example: string | null;
  tags: string | null;
  severity: Severity;
  created_at: string;
  updated_at: string;
  /** Soft delete. Non-null means every search path hides it; get_memory still reads it. */
  archived_at: string | null;
  archive_reason: ArchiveReason | null;
  /** The memory that replaced this one. The "CORRECTION to [[...]]" convention, as state. */
  superseded_by: string | null;
  /** When the curator last judged this row. */
  curated_at: string | null;
  curator_edit_count: number;
  /** Appended by the curator. It never overwrites a fact; it annotates one. */
  curator_note: string | null;
  /** 1 when a human-facing write touched this row since the curator last saw it. */
  dirty: number;
}

/**
 * Every reason carries a predicate the wrapper re-verifies before the action stands.
 * A free-text reason would always "succeed" — "stale" absorbs anything — so the ones
 * with no machine-checkable test are proposal-only and never applied unattended.
 */
export type ArchiveReason = "duplicate_of" | "superseded_by" | "stale" | "no_longer_relevant";

export type RelationKind = "supersedes" | "corrects" | "contradicts" | "duplicate_of" | "refines";

export interface MemoryRelation {
  id: string;
  from_id: string;
  to_id: string;
  kind: RelationKind;
  note: string | null;
  created_at: string;
  created_by: string;
}

export interface MemoryRevision {
  id: string;
  memory_id: string;
  run_id: string | null;
  column_name: string;
  old_value: string | null;
  new_value: string | null;
  changed_at: string;
  changed_by: string;
}

export interface CurationRun {
  id: string;
  mode: "nightly" | "sweep";
  started_at: string;
  finished_at: string | null;
  status: "running" | "ok" | "failed" | "rolled_back";
  window_from: string | null;
  window_to: string | null;
  candidates: number;
  applied: number;
  proposed: number;
  notes: string | null;
}

export interface CurationAction {
  id: string;
  run_id: string;
  memory_id: string;
  verdict: string;
  tier: "applied" | "proposed" | "refused";
  reason: string | null;
  cites: string | null;
  rationale: string | null;
  created_at: string;
  /** Set when a human answers a proposal, from the dashboard. NULL means still open. */
  resolved_at: string | null;
  resolution: ProposalResolution | null;
  resolution_note: string | null;
}

/**
 * On a proposal — applied: the human did what was proposed; dismissed: they decided
 * against it. On an applied action — undone: the human reverted it from the dashboard.
 */
export type ProposalResolution = "applied" | "dismissed" | "undone";

export type MemoryType = "bug" | "pattern" | "gotcha" | "solution" | "learning";

export type Severity = "critical" | "major" | "minor" | "info";

export interface SessionLogEntry {
  id: string;
  work_date: string;
  created_at: string;
  project: string | null;
  summary: string;
  tags: string | null;
}

export interface RuleEntry {
  id: string;
  rule: string;
  mode: RuleMode;
  project: string | null;
  area: string | null;
  rationale: string | null;
  priority: RulePriority;
  active: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export type RuleMode = "always" | "never" | "prefer" | "ask";

export type RulePriority = "critical" | "high" | "normal";
