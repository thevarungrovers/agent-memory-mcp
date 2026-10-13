import type { MemoryEntry } from "../types.js";

/**
 * Token-set similarity over the text a search would actually match on.
 *
 * This exists so the autonomy boundary is computable rather than judged. "These two
 * look like duplicates" is exactly the judgement an LLM makes confidently and wrongly:
 * three memories about `gh --repo` resolution may be three different gotchas (a
 * worktree with no remote, a stale gh-resolved config, a token scope), and collapsing
 * them loses the two that mattered. So a merge or duplicate-archive may only be
 * applied unattended when the overlap is near-total, and the score is recomputed here
 * at apply time rather than taken from the model's word for it.
 */
const STOP = new Set([
  "the", "and", "for", "not", "but", "with", "that", "this", "from", "into", "when",
  "then", "than", "you", "your", "are", "was", "were", "has", "have", "had", "its",
  "it", "is", "to", "of", "in", "on", "at", "by", "as", "an", "a", "or", "if", "be",
]);

export function tokenize(text: string): Set<string> {
  return new Set(
    (text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_.:/-]+/i)
      .map((t) => t.replace(/^[.:/-]+|[.:/-]+$/g, ""))
      .filter((t) => t.length >= 3 && !STOP.has(t))
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / (a.size + b.size - shared);
}

/** The comparison surface is symptom + fix: what the entry is about and what it says to do. */
export function memorySimilarity(a: MemoryEntry, b: MemoryEntry): number {
  return jaccard(tokenize(`${a.symptom} ${a.fix}`), tokenize(`${b.symptom} ${b.fix}`));
}

/**
 * The literal tokens that make a memory findable: exact error strings, flags, paths,
 * identifiers, line numbers. If an edit drops one of these the entry may still read
 * well and have become unreachable by the search that would have wanted it, so the
 * apply step refuses any edit whose fingerprint is not a superset of the original's.
 */
export function literalFingerprint(entry: MemoryEntry): Set<string> {
  const surface = `${entry.title} ${entry.symptom} ${entry.root_cause ?? ""} ${entry.fix} ${entry.code_example ?? ""}`;
  const out = new Set<string>();
  const patterns = [
    /--?[a-z][a-z0-9-]{2,}/gi,            // --repo, -C
    /\b[A-Z][A-Z0-9_]{3,}\b/g,            // ENOTEMPTY, SQLITE_CONSTRAINT_UNIQUE
    /\b\w+(?:Error|Exception|Warning)\b/g, // SqliteError
    /\b\d+\.\d+\.\d+\b/g,                 // versions
    /\b[\w./-]+\.(?:ts|js|mjs|php|py|sh|vue|json|sql|yaml|yml|plist)\b/g, // paths
    /`[^`\n]{2,40}`/g,                    // inline code
  ];
  for (const re of patterns) {
    for (const m of surface.matchAll(re)) out.add(m[0].toLowerCase());
  }
  return out;
}
