import { BundleWriter } from "./bundle";
import type { Config } from "./config";
import { buildManifest, type Manifest, type ResourceMeta } from "./manifest";
import { SourceClient, SourceError } from "./sources/client";
import { dateRangeProblem, fetchRecords, parentIdsOf, type DateRange } from "./sources/fetch";
import { getSource, resourcesForCategories } from "./sources";
import { scopesFor, type Credentials, type ResourceDef, type SourceDef } from "./sources/types";

export interface ExportResult {
  bundleDir: string;
  manifest: Manifest;
  /** The first `previewLimit` records of each resource (the UI renders these). */
  preview?: Record<string, unknown[]>;
}

export type ExportProgress =
  | { type: "plan"; resources: string[] }
  | { type: "resource_start"; resource: string }
  | { type: "resource_progress"; resource: string; done: number; total: number }
  | { type: "resource_done"; resource: string; count: number }
  | { type: "resource_skipped"; resource: string; status: "skipped" | "failed"; reason: string; scope?: string };

export interface RunExportOptions {
  config: Config;
  credentials: Credentials;
  /** Category ids to export. Defaults to config.export.categories, then every category the source has. */
  categories?: string[];
  /** Injectable for tests. */
  clientFactory?: (source: SourceDef, signal?: AbortSignal) => SourceClient;
  log?: (msg: string) => void;
  onProgress?: (event: ExportProgress) => void;
  /** Cancels in-flight requests; a cancelled export throws and leaves no bundle behind. */
  signal?: AbortSignal;
  exporterVersion?: string;
  /** Keep up to this many records per resource in memory and return them. Off by default to keep the CLI lean. */
  previewLimit?: number;
}

export function createClient(config: Config, credentials: Credentials, signal?: AbortSignal): SourceClient {
  const source = getSource(config.source.system);
  return new SourceClient({
    source,
    credentials,
    apiBase: config.source.api_base ?? (process.env[source.apiBaseEnv] || undefined),
    scopes: config.source.scopes ?? scopesFor(source),
    rateLimitRps: config.runtime.rate_limit_rps,
    maxRetries: config.runtime.max_retries,
    signal,
  });
}

/** Category ids a request names that the source doesn't have. */
export function unknownCategories(source: SourceDef, categories: string[]): string[] {
  const known = new Set(source.categories.map((c) => c.id));
  return categories.filter((c) => !known.has(c));
}

/**
 * Orchestrates one full-snapshot export: authenticate, stream each resource
 * raw-faithfully to JSONL, then write the manifest and the _SUCCESS sentinel.
 * A resource the token can't read is recorded as skipped and the run carries on.
 */
export async function runExport(opts: RunExportOptions): Promise<ExportResult> {
  const log = opts.log ?? (() => {});
  const progress = opts.onProgress ?? (() => {});
  const startedAt = new Date().toISOString();
  const { config } = opts;
  const source = getSource(config.source.system);

  const categories = opts.categories ?? config.export.categories ?? source.categories.map((c) => c.id);
  const unknown = unknownCategories(source, categories);
  if (unknown.length) {
    throw new Error(
      `${source.label} has no ${unknown.map((c) => `"${c}"`).join(", ")} category. Choose from: ${source.categories.map((c) => c.id).join(", ")}.`,
    );
  }
  const names = resourcesForCategories(source, categories);
  if (names.length === 0) {
    throw new Error(`No resources wired for categories [${categories.join(", ")}] — is this category implemented yet?`);
  }

  const client = opts.clientFactory?.(source, opts.signal) ?? createClient(config, opts.credentials, opts.signal);
  const dateRange: DateRange | undefined = config.export.filters.date_range;
  const rangeProblem = dateRange && dateRangeProblem(dateRange);
  if (rangeProblem) throw new Error(`Invalid export.filters.date_range: ${rangeProblem}`);
  const parentNames = new Set(names.flatMap((n) => source.resources[n]?.parent?.resource ?? []));

  progress({ type: "plan", resources: names });
  if (dateRange) {
    const dated = names.filter((n) => source.resources[n]?.dateFilter);
    if (dated.length) log(`history: ${dateRange.from} → ${dateRange.to} (${dated.join(", ")}; everything else in full)`);
  }
  await client.authenticate();

  const bundle = new BundleWriter(config.output.path, source.id);
  await bundle.init();
  log(`bundle: ${bundle.bundleDir}`);

  const preview: Record<string, unknown[]> | undefined = opts.previewLimit ? {} : undefined;
  const parentIds: Record<string, string[]> = {};
  const metas: Record<string, ResourceMeta> = {};

  const skip = (name: string, status: "skipped" | "failed", reason: string, scope?: string) => {
    metas[name] = bundle.markResource(name, status, reason, scope);
    log(`  ${name}: ${status} — ${reason}`);
    progress({ type: "resource_skipped", resource: name, status, reason, ...(scope ? { scope } : {}) });
  };

  try {
    for (const name of names) {
      opts.signal?.throwIfAborted();
      const def = source.resources[name] as ResourceDef;

      if (def.parent && metas[def.parent.resource]?.status !== "complete") {
        const parentLabel = source.resources[def.parent.resource]?.label.toLowerCase() ?? def.parent.resource;
        skip(name, "skipped", `Needs ${parentLabel}, which couldn't be exported.`);
        continue;
      }

      log(`fetching ${name}…`);
      progress({ type: "resource_start", resource: name });
      const rows: unknown[] = [];
      const ids: string[] = [];
      const limit = opts.previewLimit ?? 0;
      const records = fetchRecords(client, source, name, {
        dateRange,
        parentIds: def.parent ? parentIds[def.parent.resource] : undefined,
        signal: opts.signal,
        onParentDone: (done, total) => progress({ type: "resource_progress", resource: name, done, total }),
      });
      const tee = async function* () {
        for await (const r of records) {
          if (rows.length < limit) rows.push(r);
          if (parentNames.has(name)) ids.push(...parentIdsOf(source, name, [r]));
          yield r;
        }
      };

      try {
        const meta = await bundle.writeResource(name, tee());
        metas[name] = meta;
        if (preview) preview[name] = rows;
        if (parentNames.has(name)) parentIds[name] = ids;
        log(`  ${name}: ${meta.row_count} records`);
        progress({ type: "resource_done", resource: name, count: meta.row_count });
      } catch (e) {
        if (!(e instanceof SourceError)) throw e;
        switch (e.kind) {
          case "forbidden":
            skip(name, "skipped", `${source.label} denied access${def.scope ? ` — the token needs ${def.scope}` : ""}.`, def.scope);
            break;
          case "not_found":
            skip(name, "skipped", `${source.label} doesn't have this for your account.`);
            break;
          case "bad_request":
          case "rate_limited":
          case "server":
          case "protocol":
            skip(name, "failed", e.message);
            break;
          case "auth":
          case "network":
            throw e;
          default: {
            const never: never = e.kind;
            throw new Error(`Unhandled error kind: ${String(never)}`);
          }
        }
      }
    }
    opts.signal?.throwIfAborted();

    if (!Object.values(metas).some((m) => m.status === "complete")) {
      const reasons = [...new Set(Object.values(metas).map((m) => m.reason).filter(Boolean))];
      throw new Error(`Nothing could be exported from ${source.label}. ${reasons.join(" ")}`.trim());
    }

    const manifest = buildManifest({
      exporterVersion: opts.exporterVersion ?? "0.2.0",
      system: source.id,
      apiVersion: source.apiVersion,
      runId: bundle.runId,
      startedAt,
      completedAt: new Date().toISOString(),
      mode: config.export.mode,
      filters: config.export.filters,
      categories,
      resources: bundle.getResources(),
      counts: bundle.getCounts(),
    });
    await bundle.writeManifest(manifest);
    await bundle.writeSuccess();
    log(`done: ${bundle.bundleDir}`);
    return { bundleDir: bundle.bundleDir, manifest, preview };
  } catch (e) {
    await bundle.discard();
    throw e;
  }
}
