import { fileURLToPath } from "node:url";
import type { Config, Credentials } from "../config";
import { runExport } from "../export";
import type { Category } from "../manifest";

const DEFAULT_API_BASE = "https://api.ramp.com/developer/v1";
const DEFAULT_SCOPES = [
  "users:read", "departments:read", "locations:read",
  "cards:read", "limits:read", "spend_programs:read",
  "vendors:read", "bills:read", "transactions:read",
];
const VALID_CATEGORIES: Category[] = ["users", "cards", "vendors"];

export interface UiServerOptions {
  port?: number;
  /** Override the Ramp base URL (used by tests/smokes). Falls back to RAMP_API_BASE then prod. */
  apiBase?: string;
  /** Where bundles are written on disk. */
  outputPath?: string;
}

interface ExportRequest {
  clientId?: string;
  clientSecret?: string;
  categories?: string[];
  dateRange?: { from?: string; to?: string };
}

const HTML_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

export function startUiServer(opts: UiServerOptions = {}) {
  const apiBase = opts.apiBase ?? process.env.RAMP_API_BASE ?? DEFAULT_API_BASE;
  const outputPath = opts.outputPath ?? "./exports";

  const server = Bun.serve({
    port: opts.port ?? 4747,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(Bun.file(HTML_PATH), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST" && url.pathname === "/api/export") {
        return handleExport(req, apiBase, outputPath);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { server, url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

async function handleExport(req: Request, apiBase: string, outputPath: string): Promise<Response> {
  let body: ExportRequest;
  try {
    body = (await req.json()) as ExportRequest;
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }

  const clientId = body.clientId?.trim();
  const clientSecret = body.clientSecret?.trim();
  if (!clientId || !clientSecret) {
    return json({ ok: false, error: "Client ID and Client Secret are required." }, 400);
  }

  const categories = (body.categories ?? []).filter((c): c is Category =>
    (VALID_CATEGORIES as string[]).includes(c),
  );
  if (categories.length === 0) {
    return json({ ok: false, error: "Select at least one category." }, 400);
  }

  const dr = body.dateRange;
  const dateRange = dr?.from && dr?.to ? { from: dr.from, to: dr.to } : undefined;

  const config: Config = {
    format_version: "1.0",
    source: { api_base: apiBase, scopes: DEFAULT_SCOPES },
    export: { categories, mode: "full", filters: dateRange ? { date_range: dateRange } : {} },
    output: { backend: "local", path: outputPath },
    runtime: { rate_limit_rps: 8, max_retries: 6, log_format: "text" },
  };
  const credentials: Credentials = { clientId, clientSecret };

  try {
    const result = await runExport({ config, credentials, categories, collectRecords: true });
    const counts: Record<string, number> = {};
    for (const [name, rows] of Object.entries(result.records ?? {})) counts[name] = rows.length;
    return json({
      ok: true,
      bundleDir: result.bundleDir,
      runId: result.manifest.run.run_id,
      counts,
      resources: result.records ?? {},
    });
  } catch (e) {
    // Surface the message (e.g. Ramp's scope/422 errors) — never the credentials.
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
