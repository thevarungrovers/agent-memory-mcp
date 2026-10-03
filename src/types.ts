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
}

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
