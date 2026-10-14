import { stat } from "node:fs/promises";
import { relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config, Credentials } from "../config";
import { runExport, type ExportProgress } from "../export";
import type { Category } from "../manifest";
import { RampApiError, RampClient } from "../ramp/client";

const DEFAULT_API_BASE = "https://api.ramp.com/developer/v1";
const DEFAULT_SCOPES = [
  "users:read", "departments:read", "locations:read", "entities:read",
  "cards:read", "spend_programs:read", "funds:read",
  "vendors:read", "bills:read", "transactions:read",
];
const VALID_CATEGORIES: Category[] = ["users", "cards", "vendors"];
const RAMP_SAYS = " — Ramp says: ";
const NDJSON = "application/x-ndjson";

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

interface ErrorBody {
  ok: false;
  error: string;
  status?: number;
  rampSays?: string;
  missingScopes?: string[];
}

const HTML_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

export function startUiServer(opts: UiServerOptions = {}) {
  const apiBase = opts.apiBase ?? process.env.RAMP_API_BASE ?? DEFAULT_API_BASE;
  const outputPath = resolve(opts.outputPath ?? "./exports");

  const server = Bun.serve({
    port: opts.port ?? 4747,
    hostname: "127.0.0.1",
    // Large accounts fetch for minutes between progress lines; Bun's default 10s idle timeout would cut them off.
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(Bun.file(HTML_PATH), { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (req.method === "POST" && url.pathname === "/api/connect") {
        return handleConnect(req, apiBase);
      }
      if (req.method === "POST" && url.pathname === "/api/export") {
        return handleExport(req, apiBase, outputPath);
      }
      if (req.method === "POST" && url.pathname === "/api/reveal") {
        return handleReveal(req, outputPath);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return { server, url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

async function readBody(req: Request): Promise<ExportRequest | undefined> {
  try {
    return (await req.json()) as ExportRequest;
  } catch {
    return undefined;
  }
}

function readCredentials(body: ExportRequest): Credentials | undefined {
  const clientId = body.clientId?.trim();
  const clientSecret = body.clientSecret?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

/** Authenticates only. Ramp validates every requested scope at token time, so this catches a missing scope up front. */
async function handleConnect(req: Request, apiBase: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return json({ ok: false, error: "Invalid request body." }, 400);
  const credentials = readCredentials(body);
  if (!credentials) return json({ ok: false, error: "Client ID and Client Secret are required." }, 400);

  try {
    await new RampClient({ apiBase, credentials, scopes: DEFAULT_SCOPES }).authenticate();
    return json({ ok: true });
  } catch (e) {
    return json(toErrorBody(e));
  }
}

async function handleExport(req: Request, apiBase: string, outputPath: string): Promise<Response> {
  const body = await readBody(req);
  if (!body) return json({ ok: false, error: "Invalid request body." }, 400);
  const credentials = readCredentials(body);
  if (!credentials) return json({ ok: false, error: "Client ID and Client Secret are required." }, 400);

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

  const run = async (onProgress?: (e: ExportProgress) => void, signal?: AbortSignal) => {
    const result = await runExport({ config, credentials, categories, collectRecords: true, onProgress, signal });
    const counts: Record<string, number> = {};
    for (const [name, rows] of Object.entries(result.records ?? {})) counts[name] = rows.length;
    return {
      ok: true as const,
      bundleDir: result.bundleDir,
      runId: result.manifest.run.run_id,
      counts,
      resources: result.records ?? {},
    };
  };

  if (!req.headers.get("accept")?.includes(NDJSON)) {
    try {
      return json(await run());
    } catch (e) {
      return json(toErrorBody(e));
    }
  }

  // Streamed: one JSON line per progress event, then a final `result` or `error` line.
  const abort = new AbortController();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
      };
      try {
        send({ type: "result", ...(await run(send, abort.signal)) });
      } catch (e) {
        send({ type: "error", ...toErrorBody(e) });
      }
      if (!abort.signal.aborted) controller.close();
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, { headers: { "content-type": NDJSON, "cache-control": "no-store" } });
}

/** Opens a finished bundle in the OS file browser. Only paths inside the output folder are allowed. */
async function handleReveal(req: Request, outputPath: string): Promise<Response> {
  let dir: string | undefined;
  try {
    dir = ((await req.json()) as { bundleDir?: string }).bundleDir;
  } catch {
    return json({ ok: false, error: "Invalid request body." }, 400);
  }
  if (!dir) return json({ ok: false, error: "bundleDir is required." }, 400);

  const target = resolve(dir);
  const rel = relative(outputPath, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    return json({ ok: false, error: "That folder isn't an export bundle." }, 400);
  }
  try {
    if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
  } catch {
    return json({ ok: false, error: "That export folder no longer exists." }, 404);
  }

  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  Bun.spawn([opener, target], { stdout: "ignore", stderr: "ignore" });
  return json({ ok: true });
}

/** Splits Ramp's redacted error body out of the message and names any of our scopes it mentions. */
function toErrorBody(e: unknown): ErrorBody {
  const message = e instanceof Error ? e.message : String(e);
  const [error, rampSays] = message.split(RAMP_SAYS);
  const status = e instanceof RampApiError ? e.status : /\((\d{3})\)/.exec(message)?.[1];
  return {
    ok: false,
    error: error ?? message,
    ...(status ? { status: Number(status) } : {}),
    ...(rampSays ? { rampSays } : {}),
    missingScopes: rampSays ? DEFAULT_SCOPES.filter((s) => rampSays.includes(s)) : [],
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
