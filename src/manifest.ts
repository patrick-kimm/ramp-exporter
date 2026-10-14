import type { SourceId } from "./sources/types";

/**
 * The export manifest — written (last, atomically) at the bundle root as
 * export-metadata.json. This is the ONLY coupling between this exporter and the
 * Migration Cockpit. Keep it in sync with docs/export-metadata.schema.json.
 */

export type ResourceStatus = "complete" | "partial" | "skipped" | "failed";
export type RunStatus = "complete" | "partial" | "failed";

export interface ResourceMeta {
  /** Absent when nothing was written (skipped / failed). */
  file?: string;
  format?: "jsonl";
  row_count: number;
  sha256?: string;
  status: ResourceStatus;
  /** Why a resource was skipped or failed, in plain words. */
  reason?: string;
  /** The token permission that would have allowed it. */
  scope?: string;
}

export interface Manifest {
  format_version: string;
  exporter: { name: "ramp-exporter"; version: string; git_sha?: string };
  source: { system: SourceId; api_version?: string };
  run: {
    run_id: string;
    started_at: string;
    completed_at?: string;
    status: RunStatus;
    mode: "full";
  };
  filters?: { date_range?: { from: string; to: string } };
  categories?: string[];
  resources: Record<string, ResourceMeta>;
  counts_summary?: Record<string, number>;
}

/** 1.1: multiple source systems, `{system}/{run_id}` layout, skipped/failed resources without files. */
export const FORMAT_VERSION = "1.1";

export function runStatusOf(resources: Record<string, ResourceMeta>): RunStatus {
  const metas = Object.values(resources);
  if (metas.length > 0 && metas.every((m) => m.status === "complete")) return "complete";
  return metas.some((m) => m.status === "complete") ? "partial" : "failed";
}

export function buildManifest(input: {
  exporterVersion: string;
  system: SourceId;
  runId: string;
  startedAt: string;
  completedAt: string;
  mode: "full";
  resources: Record<string, ResourceMeta>;
  counts: Record<string, number>;
  filters?: { date_range?: { from: string; to: string } };
  categories?: string[];
  apiVersion?: string;
  gitSha?: string;
}): Manifest {
  return {
    format_version: FORMAT_VERSION,
    exporter: { name: "ramp-exporter", version: input.exporterVersion, git_sha: input.gitSha },
    source: { system: input.system, api_version: input.apiVersion },
    run: {
      run_id: input.runId,
      started_at: input.startedAt,
      completed_at: input.completedAt,
      status: runStatusOf(input.resources),
      mode: input.mode,
    },
    filters: input.filters,
    categories: input.categories,
    resources: input.resources,
    counts_summary: input.counts,
  };
}
