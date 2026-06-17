/**
 * The export manifest — written (last, atomically) at the bundle root as
 * export-metadata.json. This is the ONLY coupling between this exporter and the
 * Migration Cockpit. Keep it in sync with docs/export-metadata.schema.json.
 */

export type ResourceStatus = "complete" | "partial" | "skipped" | "failed";
export type Category = "users" | "cards" | "vendors";

export interface ResourceMeta {
  file: string;
  format: "jsonl";
  row_count: number;
  sha256: string;
  status: ResourceStatus;
}

export interface Manifest {
  format_version: string;
  exporter: { name: "ramp-exporter"; version: string; git_sha?: string };
  source: { system: "ramp"; api_version?: string };
  run: {
    run_id: string;
    started_at: string;
    completed_at?: string;
    status: "complete" | "partial" | "failed";
    mode: "full";
  };
  filters?: { date_range?: { from: string; to: string } };
  categories?: Category[];
  resources: Record<string, ResourceMeta>;
  counts_summary?: Record<string, number>;
}

export const FORMAT_VERSION = "1.0";

export function buildManifest(input: {
  exporterVersion: string;
  runId: string;
  startedAt: string;
  completedAt: string;
  mode: "full";
  resources: Record<string, ResourceMeta>;
  counts: Record<string, number>;
  filters?: { date_range?: { from: string; to: string } };
  categories?: Category[];
  apiVersion?: string;
  gitSha?: string;
}): Manifest {
  return {
    format_version: FORMAT_VERSION,
    exporter: { name: "ramp-exporter", version: input.exporterVersion, git_sha: input.gitSha },
    source: { system: "ramp", api_version: input.apiVersion ?? "developer/v1" },
    run: {
      run_id: input.runId,
      started_at: input.startedAt,
      completed_at: input.completedAt,
      status: "complete",
      mode: input.mode,
    },
    filters: input.filters,
    categories: input.categories,
    resources: input.resources,
    counts_summary: input.counts,
  };
}
