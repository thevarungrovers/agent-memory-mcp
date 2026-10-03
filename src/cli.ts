/**
 * Thin command-line face on the same storage the MCP tools use.
 *
 * It exists for one reason: a Claude Code hook is a shell command and cannot call
 * an MCP tool, so without this the hook would have to open memory.db and write its
 * own SQL — a second code path to the same rows, free to drift from the first.
 * Everything here goes through db.ts exactly as the tools do.
 *
 * It never fails loudly. A hook that errors is a hook that disrupts every session
 * start, so an unreadable database means no output and exit 0.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { getActiveRules } from "./db.js";
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
    } else {
      flags[arg.slice(2)] = rest[i + 1] ?? "";
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

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (command !== "rules") {
    process.stderr.write(
      "Usage: agent-memory rules [--project <name> | --cwd <path>] [--format hook|markdown|json]\n"
    );
    process.exit(command ? 1 : 0);
  }

  const project = flags.project || (flags.cwd ? resolveProject(flags.cwd) : null);
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
  process.exit(0);
}
