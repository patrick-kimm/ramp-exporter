import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, type Config } from "../config";
import { createClient, runExport, unknownCategories, type ExportProgress } from "../export";
import type { ResourceMeta } from "../manifest";
import { SourceClient, SourceError, type SourceErrorKind } from "../sources/client";
import { checkAccess, dateRangeProblem } from "../sources/fetch";
import { SOURCES, SOURCE_IDS, getSource, isSourceId } from "../sources";
import { scopesFor, type Credentials, type SourceDef, type SourceId } from "../sources/types";

const NDJSON = "application/x-ndjson";
/** Records per resource sent back for the review screen; the files on disk have everything. */
const PREVIEW_LIMIT = 250;

export interface UiServerOptions {
  port?: number;
  /** Per-source API base overrides (tests, sandboxes). Falls back to each source's env var, then production. */
  apiBases?: Partial<Record<SourceId, string>>;
  /** Where bundles are written on disk. */
  outputPath?: string;
  /** Tests run against local mocks and don't need production pacing. */
  rateLimitRps?: number;
}

interface ExportRequest {
  source?: string;
  credentials?: Record<string, string>;
  /** Pre-multi-source request shape (Ramp only). */
  clientId?: string;
  clientSecret?: string;
  categories?: string[];
  dateRange?: { from?: string; to?: string };
}

interface ErrorBody {
  ok: false;
  error: string;
  kind?: SourceErrorKind | "request";
  status?: number;
  /** The source's own error text, credentials redacted. */
  detail?: string;
  missingScopes?: string[];
}

const HTML_PATH = fileURLToPath(new URL("./index.html", import.meta.url));

export function startUiServer(opts: UiServerOptions = {}) {
  const outputPath = resolve(opts.outputPath ?? "./exports");
  const ctx: Ctx = { outputPath, apiBases: opts.apiBases ?? {}, rateLimitRps: opts.rateLimitRps };

  const serve = (port: number) =>
    Bun.serve({
      port,
      hostname: "127.0.0.1",
      // Large accounts fetch for minutes between progress lines; Bun's default 10s idle timeout would cut them off.
      idleTimeout: 0,
      fetch: (req) => route(req, ctx),
    });

  const requested = opts.port ?? 4747;
  let server: ReturnType<typeof serve> | undefined;
  // A second copy (or something else) on 4747 shouldn't stop the UI from starting.
  for (let port = requested, tries = 0; !server; port++, tries++) {
    try {
      server = serve(port);
    } catch (e) {
      if (requested === 0 || tries >= 9 || (e as { code?: string }).code !== "EADDRINUSE") throw e;
    }
  }

  return { server, url: `http://localhost:${server.port}`, stop: () => server.stop(true) };
}

interface Ctx {
  outputPath: string;
  apiBases: Partial<Record<SourceId, string>>;
  rateLimitRps?: number;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Only this page may drive the server: other sites open in the same browser can reach
 * 127.0.0.1 too, directly (Origin) or through DNS rebinding (Host).
 */
function isLocalRequest(req: Request, url: URL): boolean {
  if (!LOCAL_HOSTS.has(url.hostname)) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try {
    const o = new URL(origin);
    return LOCAL_HOSTS.has(o.hostname) && o.port === url.port;
  } catch {
    return false;
  }
}

async function route(req: Request, ctx: Ctx): Promise<Response> {
  const url = new URL(req.url);
  if (!isLocalRequest(req, url)) return new Response("forbidden", { status: 403 });
  if (req.method === "GET" && url.pathname === "/") {
    return new Response(Bun.file(HTML_PATH), { headers: { "content-type": "text/html; charset=utf-8" } });
  }
  if (req.method === "GET" && url.pathname === "/api/sources") return json({ sources: SOURCE_IDS.map((id) => publicSource(SOURCES[id])) });
  if (req.method === "POST" && url.pathname === "/api/connect") return handleConnect(req, ctx);
  if (req.method === "POST" && url.pathname === "/api/export") return handleExport(req, ctx);
  if (req.method === "POST" && url.pathname === "/api/reveal") return handleReveal(req, ctx.outputPath);
  return new Response("not found", { status: 404 });
}

/** What the page needs to render a source: copy, fields, categories, and resource labels. No functions, no secrets. */
function publicSource(s: SourceDef) {
  return {
    id: s.id,
    label: s.label,
    tagline: s.tagline,
    credentials: s.credentials,
    setup: s.setup,
    scopes: scopesFor(s),
    rateLimitRps: s.rateLimitRps,
    categories: s.categories,
    resources: Object.fromEntries(
      Object.entries(s.resources).map(([name, r]) => [
        name,
        {
          label: r.label,
          one: r.one,
          idField: r.idField ?? "id",
          dated: Boolean(r.dateFilter),
          sensitive: Boolean(r.sensitive),
          ...(r.scope ? { scope: r.scope } : {}),
          ...(r.parent ? { parent: r.parent.resource } : {}),
        },
      ]),
    ),
  };
}

async function readBody(req: Request): Promise<ExportRequest | undefined> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as ExportRequest) : undefined;
  } catch {
    return undefined;
  }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; response: Response };

function parseSourceAndCredentials(body: ExportRequest | undefined): Parsed<{ source: SourceDef; credentials: Credentials }> {
  if (!body) return { ok: false, response: badRequest("Invalid request body.") };
  const id = body.source ?? "ramp";
  if (!isSourceId(id)) return { ok: false, response: badRequest(`Unknown source "${id}".`) };
  const source = getSource(id);
  const credentials: Credentials = {};
  const missing: string[] = [];
  for (const field of source.credentials) {
    const raw = body.credentials?.[field.key] ?? (body as Record<string, unknown>)[field.key];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) credentials[field.key] = value;
    else missing.push(field.label);
  }
  if (missing.length) {
    return { ok: false, response: badRequest(`${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} required.`) };
  }
  return { ok: true, value: { source, credentials } };
}

function configFor(source: SourceDef, ctx: Ctx, extra: Partial<Config["export"]> = {}): Config {
  return parseConfig({
    source: { system: source.id, api_base: ctx.apiBases[source.id] },
    export: { ...extra },
    output: { path: ctx.outputPath },
    runtime: ctx.rateLimitRps ? { rate_limit_rps: ctx.rateLimitRps } : {},
  });
}

/** Authenticates, then checks every resource with one tiny request so missing access shows up before the export. */
async function handleConnect(req: Request, ctx: Ctx): Promise<Response> {
  const parsed = parseSourceAndCredentials(await readBody(req));
  if (!parsed.ok) return parsed.response;
  const { source, credentials } = parsed.value;
  const client: SourceClient = createClient(configFor(source, ctx), credentials, req.signal);
  try {
    const names = Object.keys(source.resources);
    const report = await checkAccess(client, source, names);
    return json({ ok: true, ...report });
  } catch (e) {
    return json(toErrorBody(e, source));
  }
}

function parseDateRange(dr: ExportRequest["dateRange"]): Parsed<{ from: string; to: string } | undefined> {
  if (!dr || (!dr.from && !dr.to)) return { ok: true, value: undefined };
  const problem = dateRangeProblem(dr);
  if (problem) return { ok: false, response: badRequest(problem) };
  return { ok: true, value: { from: dr.from!, to: dr.to! } };
}

async function handleExport(req: Request, ctx: Ctx): Promise<Response> {
  const body = await readBody(req);
  const parsed = parseSourceAndCredentials(body);
  if (!parsed.ok) return parsed.response;
  const { source, credentials } = parsed.value;

  const categories = (body?.categories ?? []).filter((c): c is string => typeof c === "string");
  if (categories.length === 0) return badRequest("Select at least one category.");
  const unknown = unknownCategories(source, categories);
  if (unknown.length) return badRequest(`${source.label} has no ${unknown.join(", ")} category.`);

  const range = parseDateRange(body?.dateRange);
  if (!range.ok) return range.response;
  const config = configFor(source, ctx, {
    categories,
    mode: "full",
    filters: range.value ? { date_range: range.value } : {},
  });

  const run = async (onProgress?: (e: ExportProgress) => void, signal?: AbortSignal) => {
    const result = await runExport({ config, credentials, categories, previewLimit: PREVIEW_LIMIT, onProgress, signal });
    const skipped: Record<string, Pick<ResourceMeta, "status" | "reason" | "scope">> = {};
    for (const [name, m] of Object.entries(result.manifest.resources)) {
      if (m.status !== "complete") skipped[name] = { status: m.status, reason: m.reason, ...(m.scope ? { scope: m.scope } : {}) };
    }
    return {
      ok: true as const,
      source: source.id,
      bundleDir: result.bundleDir,
      runId: result.manifest.run.run_id,
      status: result.manifest.run.status,
      counts: result.manifest.counts_summary ?? {},
      resources: result.preview ?? {},
      skipped,
      previewLimit: PREVIEW_LIMIT,
    };
  };

  if (!req.headers.get("accept")?.includes(NDJSON)) {
    try {
      return json(await run(undefined, req.signal));
    } catch (e) {
      return json(toErrorBody(e, source));
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
        send({ type: "error", ...toErrorBody(e, source) });
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
    return badRequest("Invalid request body.");
  }
  if (!dir) return badRequest("bundleDir is required.");

  const target = resolve(dir);
  const rel = relative(outputPath, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return badRequest("That folder isn't an export bundle.");
  try {
    if (!(await stat(target)).isDirectory()) throw new Error("not a directory");
  } catch {
    return json({ ok: false, error: "That export folder no longer exists." }, 404);
  }

  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  Bun.spawn([opener, target], { stdout: "ignore", stderr: "ignore" });
  return json({ ok: true });
}

/** Splits the source's redacted error text out of the message and names any of its scopes it mentions. */
function toErrorBody(e: unknown, source: SourceDef): ErrorBody {
  if (e instanceof SourceError) {
    const scopes = scopesFor(source);
    return {
      ok: false,
      error: e.summary,
      kind: e.kind,
      ...(e.status ? { status: e.status } : {}),
      ...(e.detail ? { detail: e.detail } : {}),
      missingScopes: e.detail ? scopes.filter((s) => e.detail!.includes(s)) : [],
    };
  }
  return { ok: false, error: e instanceof Error ? e.message : String(e) };
}

function badRequest(error: string): Response {
  return json({ ok: false, error, kind: "request" } satisfies ErrorBody, 400);
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}