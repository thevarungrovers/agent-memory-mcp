import { getMemoryById, updateMemory } from "../db.js";
import type { MemoryEntry } from "../types.js";

/**
 * Mechanical repair for entries saved through a tool call whose XML leaked into a
 * value: a field ends with its OWN closing tag, and everything after it is the rest of
 * the call — `</fix>\n<root_cause>…</root_cause>\n<tags>…</tags>\n</invoke>`, or the
 * `<parameter name="root_cause">…` form. The later fields were never stored.
 *
 * Detection keys on a field containing its own closing tag, never on any angle bracket:
 * an entry that documents this very bug quotes `<parameter name=…>` in its symptom, and
 * values legitimately contain `<= 0` or `<anything>`. Splitting happens only at those
 * exact opener tags for the same reason.
 *
 * Nothing is guessed. A spilled value whose target field already holds different text
 * makes the whole entry a manual repair; tags are the exception, since unioning two
 * tag lists loses nothing.
 */

const FIELDS = ["symptom", "root_cause", "fix", "code_example", "trigger_context"] as const;
const TARGETS = new Set<string>([...FIELDS, "tags"]);

export interface RepairPlan {
  id: string;
  title: string;
  /** Column → before/after. Empty when there is nothing mechanical to do. */
  changes: Record<string, { before: string | null; after: string | null }>;
  /** Why it cannot be repaired automatically, when it cannot. */
  manual: string | null;
}

const OPENER = /\n?\s*<parameter name="(\w+)">|\n?\s*<(root_cause|fix|code_example|trigger_context|tags|symptom|title|area|type|severity|project)>/g;

function clean(value: string, key: string): string {
  return value
    .replace(/<\/invoke>\s*$/, "")
    .trim()
    .replace(new RegExp(`</(?:parameter|${key})>\\s*$`), "")
    .trim();
}

function splitLeak(tail: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  const marks = [...tail.matchAll(OPENER)];
  marks.forEach((m, i) => {
    const key = m[1] ?? m[2];
    const start = m.index! + m[0].length;
    const end = i + 1 < marks.length ? marks[i + 1].index! : tail.length;
    out.push({ key, value: clean(tail.slice(start, end), key) });
  });
  return out;
}

function mergeTags(a: string | null, b: string): string {
  const seen = new Set<string>();
  return [...(a ?? "").split(","), ...b.split(",")]
    .map((t) => t.trim())
    .filter((t) => t && !seen.has(t) && seen.add(t))
    .join(",");
}

export function planRepair(m: MemoryEntry): RepairPlan {
  const plan: RepairPlan = { id: m.id, title: m.title, changes: {}, manual: null };
  const next: Record<string, string | null> = {
    symptom: m.symptom, root_cause: m.root_cause, fix: m.fix,
    code_example: m.code_example, trigger_context: m.trigger_context, tags: m.tags,
  };

  for (const f of FIELDS) {
    const v = m[f] ?? "";
    const at = v.indexOf(`</${f}>`);
    if (at < 0) continue;
    next[f] = v.slice(0, at).trimEnd();
    for (const { key, value } of splitLeak(v.slice(at + `</${f}>`.length))) {
      if (!value) continue;
      if (!TARGETS.has(key)) continue; // project/severity/… are not repaired here
      if (key === "tags") {
        next.tags = mergeTags(next.tags, value);
        continue;
      }
      const current = (next[key] ?? "").trim();
      if (!current) next[key] = value;
      else if (current !== value) {
        plan.manual = `the leaked ${key.replace("_", " ")} differs from the one already stored`;
        return plan;
      }
    }
  }

  for (const [k, after] of Object.entries(next)) {
    const before = (m as unknown as Record<string, string | null>)[k];
    if ((before ?? "") !== (after ?? "")) plan.changes[k] = { before, after };
  }
  if (!Object.keys(plan.changes).length) {
    plan.manual = !m.tags || !m.tags.trim() ? "no tags, and none were leaked anywhere to recover" : "nothing mechanical to fix";
  }
  return plan;
}

export function applyRepair(id: string): RepairPlan {
  const m = getMemoryById(id);
  if (!m) throw new Error("no such memory");
  const plan = planRepair(m);
  if (plan.manual) throw new Error(`needs a manual repair: ${plan.manual}`);
  const updates: Record<string, string | null> = {};
  for (const [k, { after }] of Object.entries(plan.changes)) updates[k] = after;
  updateMemory(id, updates as Parameters<typeof updateMemory>[1], "session");
  return plan;
}
