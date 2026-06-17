import { BundleWriter } from "./bundle";
import type { Config, Credentials } from "./config";
import { buildManifest, type Category, type Manifest } from "./manifest";
import { RampClient } from "./ramp/client";
import { fetchResource, resourcesForCategories } from "./ramp/resources";

export interface ExportResult {
  bundleDir: string;
  manifest: Manifest;
}

export interface RunExportOptions {
  config: Config;
  credentials: Credentials;
  categories: Category[];
  /** Injectable for tests. */
  clientFactory?: () => RampClient;
  log?: (msg: string) => void;
  exporterVersion?: string;
}

/**
 * Orchestrates one full-snapshot export: authenticate, fetch each resource
 * raw-faithfully, write JSONL + manifest, then the _SUCCESS sentinel.
 */
export async function runExport(opts: RunExportOptions): Promise<ExportResult> {
  const log = opts.log ?? (() => {});
  const startedAt = new Date().toISOString();

  const resourceNames = resourcesForCategories(opts.categories);
  if (resourceNames.length === 0) {
    throw new Error(
      `No resources wired for categories [${opts.categories.join(", ")}] — is this category implemented yet?`,
    );
  }

  const client =
    opts.clientFactory?.() ??
    new RampClient({
      apiBase: opts.config.source.api_base,
      credentials: opts.credentials,
      scopes: opts.config.source.scopes,
      rateLimitRps: opts.config.runtime.rate_limit_rps,
      maxRetries: opts.config.runtime.max_retries,
    });

  await client.authenticate();

  const bundle = new BundleWriter(opts.config.output.path);
  await bundle.init();
  log(`bundle: ${bundle.bundleDir}`);

  for (const name of resourceNames) {
    log(`fetching ${name}…`);
    const records = await fetchResource(client, name);
    const meta = await bundle.writeResource(name, records);
    log(`  ${name}: ${meta.row_count} records`);
  }

  const manifest = buildManifest({
    exporterVersion: opts.exporterVersion ?? "0.1.0",
    runId: bundle.runId,
    startedAt,
    completedAt: new Date().toISOString(),
    mode: opts.config.export.mode,
    filters: opts.config.export.filters,
    categories: opts.categories,
    resources: bundle.getResources(),
    counts: bundle.getCounts(),
  });

  await bundle.writeManifest(manifest);
  await bundle.writeSuccess();
  log(`done: ${bundle.bundleDir}`);

  return { bundleDir: bundle.bundleDir, manifest };
}
