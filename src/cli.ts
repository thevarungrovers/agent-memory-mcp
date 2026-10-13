/**
 * Command-line face on the same storage the MCP tools use.
 *
 * Originally for one reason: a Claude Code hook is a shell command and cannot call an
 * MCP tool, so without this the hook would open memory.db and write its own SQL — a
 * second code path to the same rows, free to drift from the first. The curation
 * commands are here for a second reason: a scheduled job should not depend on an MCP
 * server at all. One spawned under launchd has been seen to die with CONNECTION_CLOSED
 * while the identical invocation works from a terminal, and a nightly job that fails
 * that way fails silently.
 *
 * Error handling differs by command on purpose. `rules` feeds a SessionStart hook, and
 * a hook that errors disrupts every session, so it stays silent and exits 0. Every
 * curation command exits non-zero and says why: a maintenance job that fails quietly
 * is worse than one that does not run.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  getActiveRules, getState, listMemories, memoryStats, revertRun, setState, snapshotTo,
} from "./db.js";
import { backfill, curate } from "./curation/run.js";
import { diffCanaries, loadBaseline, loadCanaries, runCanaries, saveBaseline } from "./curation/canary.js";
import type { RuleEntry } from "./types.js";

type Format = "hook" | "markdown" | "json";

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command = "", ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    // A flag followed by another flag (or nothing) is a boolean, not a flag with a
    // value: --hook-input --format markdown must not swallow --format as its argument.
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[arg.slice(2)] = "true";
    } else {
      flags[arg.slice(2)] = next;
      i++;
    }
  }
  return { command, flags };
}

/**
 * The project a rule should be scoped by is the repository, not the directory the
 * agent happens to have started in: a session opened in employeeapp/ is still the
 * monorepo. Walk up to the nearest .git and use that name.
 */
function resolveProject(cwd: string): string {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, ".git"))) return basename(dir);
    const parent = dirname(dir);
    if (parent === dir) return basename(resolve(cwd));
    dir = parent;
  }
}

/**
 * Claude Code hands a hook its event as JSON on stdin. Parsing it here rather than in
 * the shell script keeps the hook free of a jq dependency — jq is not reliably on a
 * hook's PATH — and keeps the one piece of real logic in a place that can be tested.
 */
function cwdFromStdin(): string | null {
  try {
    const payload = JSON.parse(readFileSync(0, "utf8"));
    return typeof payload?.cwd === "string" && payload.cwd ? payload.cwd : null;
  } catch {
    return null;
  }
}

function formatHook(rules: RuleEntry[]): string {
  const lines = rules.map((rule) => {
    const scope = rule.project ? ` [${rule.project}]` : "";
    const why = rule.rationale ? ` — ${rule.rationale}` : "";
    return `${rule.mode.toUpperCase()}${scope}: ${rule.rule}${why}`;
  });

  return [
    "<standing-rules>",
    "The user's standing instructions, loaded from agent-memory. They hold for this whole",
    "session and take precedence over your own defaults. Rules marked ASK require explicit",
    "confirmation before you act.",
    "",
    ...lines,
    "",
    "To add, change or remove one, use the agent-memory MCP tools (store_rule, update_rule,",
    "delete_rule). Never edit memory.db directly — the database is the server's to write.",
    "</standing-rules>",
  ].join("\n");
}

function formatMarkdown(rules: RuleEntry[]): string {
  return rules
    .map((rule) => {
      const scope = rule.project ? ` *[${rule.project}]*` : "";
      const why = rule.rationale ? `\n  - *Why*: ${rule.rationale}` : "";
      return `- **${rule.mode.toUpperCase()}**${scope} (${rule.priority}): ${rule.rule}${why}`;
    })
    .join("\n");
}

const USAGE = `agent-memory <command> [flags]

  rules      [--project <name> | --cwd <path> | --hook-input] [--format hook|markdown|json]
  stats      [--format json|text]
  snapshot   --out <path>                       consistent copy of the live WAL database
  memories   --since <YYYY-MM-DD> [--until <d>] [--format json|text]
  curate     [--mode nightly|sweep] [--dry-run] [--home <dir>] [--claude-bin <path>]
             [--model <name>] [--limit <n>]     one full curation pass
  backfill   [--batch <n>] [--max-batches <n>]  one-time walk over every entry that has
                                                never been curated. Applies only the
                                                additive verdicts; removals are proposed
  canary     [--file <path>] [--save-baseline]  pinned queries that prove retrieval still works
  undo       --run <run_id>                     revert one curation run, column by column
  state      [--get <key>] [--set <key>=<value>]

Dates are LOCAL dates. The stored timestamps are UTC, so an evening run that compared
against a UTC day would match nothing written that evening.`;

/** Curation commands live beside the built CLI by default, so a clone works unmodified. */
function curatorHome(flags: Record<string, string>): string {
  if (flags.home) return resolve(flags.home);
  if (process.env.AGENT_MEMORY_CURATOR_HOME) return resolve(process.env.AGENT_MEMORY_CURATOR_HOME);
  return resolve(join(dirname(new URL(import.meta.url).pathname), "..", "curator"));
}

function runCuration(flags: Record<string, string>): number {
  const home = curatorHome(flags);
  const stateDir = join(home, "state");
  mkdirSync(stateDir, { recursive: true });

  // PROMPT.md is read from the state dir so a local edit is possible without touching
  // the checkout; seed it from the versioned copy the first time.
  const statePrompt = join(stateDir, "PROMPT.md");
  if (!existsSync(statePrompt)) {
    const shipped = join(home, "PROMPT.md");
    if (!existsSync(shipped)) {
      process.stderr.write(`agent-memory: no PROMPT.md at ${shipped}\n`);
      return 1;
    }
    writeFileSync(statePrompt, readFileSync(shipped, "utf8"));
  }

  const result = curate({
    mode: flags.mode === "sweep" ? "sweep" : "nightly",
    stateDir,
    reportDir: join(home, "reports"),
    canariesFile: flags.canaries ? resolve(flags.canaries) : join(home, "canaries.json"),
    claudeBin: flags["claude-bin"],
    model: flags.model,
    dryRun: "dry-run" in flags,
    limit: flags.limit ? Number(flags.limit) : undefined,
    log: (line) => process.stdout.write(`[curate] ${line}\n`),
  });

  process.stdout.write(`\n${result.headline}\n`);
  if (result.reportPath) process.stdout.write(`report: ${result.reportPath}\n`);
  // Exit 2 is "ran, but something needs a human" — distinct from 1, a real failure.
  if (result.status === "failed") return 1;
  if (result.status === "skipped") return 2;
  return 0;
}

function runCanaryCommand(flags: Record<string, string>): number {
  const file = flags.file ? resolve(flags.file) : join(curatorHome(flags), "canaries.json");
  if (!existsSync(file)) {
    process.stderr.write(`agent-memory: no canary file at ${file}\n`);
    return 1;
  }
  const canaries = loadCanaries(file);
  const current = runCanaries(canaries);

  if ("save-baseline" in flags) {
    saveBaseline(current);
    process.stdout.write(`baseline saved for ${current.length} canaries\n`);
    return 0;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    saveBaseline(current);
    process.stdout.write(`no baseline existed; captured one for ${current.length} canaries\n`);
    return 0;
  }

  const diff = diffCanaries(baseline, current);
  process.stdout.write(`${diff.stable}/${diff.total} canaries stable\n`);
  for (const c of diff.changed) {
    process.stdout.write(`  CHANGED ${c.name}\n    was [${c.was.join(", ")}]\n    now [${c.now.join(", ")}]\n`);
  }
  return diff.changed.length === 0 ? 0 : 2;
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "":
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
      break;

    case "stats": {
      const stats = memoryStats();
      if (flags.format === "json") {
        process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
      } else {
        process.stdout.write(
          `active ${stats.active} | archived ${stats.archived} | dirty ${stats.dirty} | `
          + `${(stats.prose_bytes / 1024).toFixed(0)}KB prose across ${stats.areas} areas | `
          + `${stats.oldest} .. ${stats.newest}\n`
        );
      }
      process.exit(0);
      break;
    }

    case "snapshot": {
      if (!flags.out) {
        process.stderr.write("agent-memory snapshot --out <path>\n");
        process.exit(1);
      }
      const out = resolve(flags.out);
      mkdirSync(dirname(out), { recursive: true });
      snapshotTo(out);
      process.stdout.write(`${out}\n`);
      process.exit(0);
      break;
    }

    case "memories": {
      const rows = listMemories({
        since: flags.since,
        until: flags.until,
        area: flags.area,
        project: flags.project,
        limit: flags.limit ? Number(flags.limit) : 500,
        include_archived: "include-archived" in flags,
      });
      if (flags.format === "json") {
        process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
      } else {
        for (const m of rows) {
          process.stdout.write(`${m.updated_at.slice(0, 10)}  ${m.id}  ${m.type}/${m.severity}  ${m.title}\n`);
        }
        process.stdout.write(`\n${rows.length} memories\n`);
      }
      process.exit(0);
      break;
    }

    case "curate":
      process.exit(runCuration(flags));
      break;

    case "backfill": {
      const home = curatorHome(flags);
      const stateDir = join(home, "state");
      mkdirSync(stateDir, { recursive: true });
      const statePrompt = join(stateDir, "PROMPT.md");
      if (!existsSync(statePrompt)) writeFileSync(statePrompt, readFileSync(join(home, "PROMPT.md"), "utf8"));

      const result = backfill({
        mode: "sweep",
        stateDir,
        reportDir: join(home, "reports"),
        canariesFile: join(home, "canaries.json"),
        claudeBin: flags["claude-bin"],
        model: flags.model,
        batchSize: flags.batch ? Number(flags.batch) : undefined,
        maxBatches: flags["max-batches"] ? Number(flags["max-batches"]) : undefined,
        log: (line) => process.stdout.write(`[backfill] ${line}\n`),
      });
      process.stdout.write(`\n${result.headline}\n`);
      if (result.reportPath) process.stdout.write(`report: ${result.reportPath}\n`);
      process.exit(result.status === "failed" ? 1 : 0);
      break;
    }

    case "canary":
      process.exit(runCanaryCommand(flags));
      break;

    case "undo": {
      if (!flags.run) {
        process.stderr.write("agent-memory undo --run <run_id>\n");
        process.exit(1);
      }
      const { reverted, skipped } = revertRun(flags.run);
      process.stdout.write(`reverted ${reverted.length} memories\n`);
      for (const s of skipped) process.stdout.write(`  SKIPPED ${s.id}: ${s.why}\n`);
      process.exit(0);
      break;
    }

    case "state": {
      if (flags.get) {
        process.stdout.write(`${getState(flags.get) ?? ""}\n`);
        process.exit(0);
      }
      if (flags.set) {
        const eq = flags.set.indexOf("=");
        if (eq < 0) {
          process.stderr.write("agent-memory state --set <key>=<value>\n");
          process.exit(1);
        }
        setState(flags.set.slice(0, eq), flags.set.slice(eq + 1));
        process.exit(0);
      }
      process.stderr.write("agent-memory state [--get <key>] [--set <key>=<value>]\n");
      process.exit(1);
      break;
    }

    case "rules":
      break;

    default:
      process.stderr.write(`${USAGE}\n`);
      process.exit(1);
  }

  const cwd = flags.cwd || ("hook-input" in flags ? cwdFromStdin() : null);
  const project = flags.project || (cwd ? resolveProject(cwd) : null);
  const rules = getActiveRules(project);
  if (rules.length === 0) return;

  const format = (flags.format || "hook") as Format;
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(rules, null, 2)}\n`);
  } else if (format === "markdown") {
    process.stdout.write(`${formatMarkdown(rules)}\n`);
  } else {
    process.stdout.write(`${formatHook(rules)}\n`);
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`agent-memory cli: ${error}\n`);
  // `rules` must never disrupt a session start, so it swallows everything. Any other
  // command is being run deliberately — usually by a scheduler — and a silent success
  // after a failure is the worst outcome available.
  const command = process.argv[2] ?? "";
  process.exit(command === "rules" || command === "" ? 0 : 1);
}
