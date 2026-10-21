import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { getCurationActions, getCurationRun, getDb, getMemoryById, searchMemories } from "../db.js";
import { act } from "./actions.js";
import { buildMemory, buildOverview } from "./model.js";

/**
 * The review dashboard: one local page over the curator's ledger, with a button for
 * every answer a proposal or a red flag can have.
 *
 * It binds to 127.0.0.1 only, and every API call must carry a token minted when the
 * process starts and embedded in the page it serves. Without the token, any website
 * open in the same browser could POST to localhost and archive memories; without the
 * Host check, a DNS-rebinding page could read them.
 */

export interface DashboardOptions {
  port: number;
  canariesFile: string | null;
  log?: (line: string) => void;
}

function pagePath(): string {
  // From dist/cli.js the page sits in ../src/dashboard; from src under tsx, beside this
  // file. The page is not bundled so it can be edited without a rebuild.
  const here = new URL(".", import.meta.url).pathname;
  for (const p of [`${here}page.html`, `${here}../src/dashboard/page.html`]) {
    if (existsSync(p)) return p;
  }
  throw new Error(`dashboard page not found beside ${here}`);
}

function send(res: ServerResponse, status: number, body: unknown, type = "application/json"): void {
  const text = type === "application/json" ? JSON.stringify(body) : String(body);
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return parsed && typeof parsed === "object" ? parsed : {};
}

export function startDashboard(opts: DashboardOptions): Promise<{ url: string; close: () => void }> {
  const token = randomBytes(24).toString("hex");
  const log = opts.log ?? (() => {});
  const allowedHosts = new Set([`127.0.0.1:${opts.port}`, `localhost:${opts.port}`]);
  // Open the store once, up front, so a problem with it fails the command rather than
  // the first request.
  getDb();

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "bad host" });
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(pagePath(), "utf8").replace("__DASHBOARD_TOKEN__", token);
        return send(res, 200, html, "text/html");
      }

      if (!url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      if (req.headers["x-dashboard-token"] !== token) return send(res, 401, { error: "bad token — reload the page" });

      if (req.method === "GET" && url.pathname === "/api/overview") {
        return send(res, 200, buildOverview(opts.canariesFile));
      }

      const mem = /^\/api\/memory\/([0-9a-f-]{8,36})$/.exec(url.pathname);
      if (req.method === "GET" && mem) {
        const body = buildMemory(mem[1]);
        return body ? send(res, 200, body) : send(res, 404, { error: "no such memory" });
      }

      const run = /^\/api\/run\/([0-9a-f-]{36})$/.exec(url.pathname);
      if (req.method === "GET" && run) {
        const r = getCurationRun(run[1]);
        if (!r) return send(res, 404, { error: "no such run" });
        const actions = getCurationActions(r.id).map((a) => ({
          ...a,
          title: getMemoryById(a.memory_id)?.title ?? "(gone)",
        }));
        return send(res, 200, { run: r, actions });
      }

      if (req.method === "GET" && url.pathname === "/api/search") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return send(res, 200, { results: [] });
        // An id or id prefix first — that is what you paste from a rationale.
        const byId = /^[0-9a-f-]{6,36}$/.test(q)
          ? (getDb().prepare("SELECT * FROM memories WHERE id LIKE ? LIMIT 5").all(`${q}%`) as { id: string }[])
          : [];
        const hits = [...byId, ...searchMemories(q, { limit: 12, include_archived: true })];
        const seen = new Set<string>();
        const results = hits
          .filter((m) => !seen.has(m.id) && seen.add(m.id))
          .map((m) => getMemoryById(m.id)!)
          .map((m) => ({ id: m.id, title: m.title, area: m.area, project: m.project, archived_at: m.archived_at }));
        return send(res, 200, { results });
      }

      if (req.method === "POST" && url.pathname === "/api/act") {
        if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
          return send(res, 415, { error: "json only" });
        }
        const body = await readJson(req);
        const action = typeof body.action === "string" ? body.action : "";
        const params = body.params && typeof body.params === "object" ? (body.params as Record<string, unknown>) : {};
        const result = act(action, params, { canariesFile: opts.canariesFile });
        log(`${result.ok ? "ok  " : "FAIL"} ${action} ${JSON.stringify(params)} — ${result.message}`);
        return send(res, result.ok ? 200 : 400, result);
      }

      return send(res, 404, { error: "not found" });
    } catch (error) {
      log(`error: ${error}`);
      return send(res, 500, { error: String(error) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${opts.port}/`, close: () => server.close() });
    });
  });
}
