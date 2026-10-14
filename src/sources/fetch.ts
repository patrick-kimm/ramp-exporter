import { SourceError, type SourceClient } from "./client";
import type { DateFormat, QueryValue, ResourceDef, SourceDef } from "./types";

export interface DateRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Why a date range can't be used, or undefined when it's fine. Both ends are inclusive days. */
export function dateRangeProblem(range: { from?: unknown; to?: unknown }): string | undefined {
  if (!isDay(range.from) || !isDay(range.to)) return "Pick both a start and an end date (YYYY-MM-DD).";
  if (range.from > range.to) return "The start date is after the end date.";
  return undefined;
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
}

/** Renders a YYYY-MM-DD (or full datetime) bound the way a given API param expects it. */
export function formatBound(value: string, bound: "from" | "to", format: DateFormat): string {
  const isDay = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const day = value.slice(0, 10);
  switch (format) {
    case "date":
      return day;
    case "date_exclusive":
      return bound === "to" ? nextDay(day) : day;
    case "datetime":
      if (!isDay) return value;
      return bound === "from" ? `${day}T00:00:00Z` : `${day}T23:59:59Z`;
    case "datetime_exclusive":
      if (!isDay) return value;
      return bound === "from" ? `${day}T00:00:00Z` : `${nextDay(day)}T00:00:00Z`;
    default: {
      const never: never = format;
      throw new Error(`Unhandled date format: ${String(never)}`);
    }
  }
}

function paramsFor(def: ResourceDef, range?: DateRange): Record<string, QueryValue> {
  const params: Record<string, QueryValue> = { ...(def.query ?? {}) };
  const f = def.dateFilter;
  if (f && range) {
    if (f.from) params[f.from.param] = formatBound(range.from, "from", f.from.format);
    if (f.to) params[f.to.param] = formatBound(range.to, "to", f.to.format);
  }
  return params;
}

function idOf(record: unknown, def: ResourceDef): string | undefined {
  const id = (record as Record<string, unknown> | null)?.[def.idField ?? "id"];
  return typeof id === "string" || typeof id === "number" ? String(id) : undefined;
}

export interface FetchOptions {
  dateRange?: DateRange;
  /** Required for sub-resources: the parent ids to fetch under. */
  parentIds?: string[];
  signal?: AbortSignal;
  onParentDone?: (done: number, total: number) => void;
}

/**
 * Streams every record of a resource, verbatim. Records repeated across pages are
 * dropped by id, and a date bound the API can't apply is applied locally.
 */
export async function* fetchRecords(
  client: SourceClient,
  source: SourceDef,
  name: string,
  opts: FetchOptions = {},
): AsyncGenerator<unknown> {
  const def = source.resources[name];
  if (!def) throw new Error(`Unknown ${source.label} resource: ${name}`);
  const params = paramsFor(def, opts.dateRange);
  const clientTo = def.dateFilter?.clientTo && opts.dateRange ? opts.dateRange.to.slice(0, 10) : undefined;
  const seen = new Set<string>();

  const keep = (record: unknown, parentId?: string): boolean => {
    const id = idOf(record, def);
    if (id !== undefined) {
      const key = parentId === undefined ? id : `${parentId}\u0000${id}`;
      if (seen.has(key)) return false;
      seen.add(key);
    }
    if (clientTo) {
      const day = (record as Record<string, unknown> | null)?.[def.dateFilter!.clientTo!];
      if (typeof day === "string" && day.slice(0, 10) > clientTo) return false;
    }
    return true;
  };

  if (!def.parent) {
    if (!def.path) throw new Error(`${name} has neither a path nor a parent`);
    for await (const record of client.paginate(def, def.path, params)) if (keep(record)) yield record;
    return;
  }

  const { linkField } = def.parent;
  const parentIds = opts.parentIds ?? [];
  let done = 0;
  for (const pid of parentIds) {
    opts.signal?.throwIfAborted();
    try {
      for await (const record of client.paginate(def, def.parent.path(pid), params)) {
        const linked = { [linkField]: pid, ...(record as Record<string, unknown>) };
        if (keep(linked, pid)) yield linked;
      }
    } catch (e) {
      // One closed or deleted parent shouldn't sink the rest.
      if (!(e instanceof SourceError && e.kind === "not_found")) throw e;
    }
    opts.onParentDone?.(++done, parentIds.length);
  }
}

export function parentIdsOf(source: SourceDef, parentName: string, records: Iterable<unknown>): string[] {
  const def = source.resources[parentName];
  if (!def) return [];
  const ids: string[] = [];
  for (const r of records) {
    const id = idOf(r, def);
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

export type Access =
  | { status: "ok" }
  /** The token lacks permission (403). */
  | { status: "denied"; scope?: string; detail?: string }
  /** The account doesn't have this (404), or the source refused the request outright. */
  | { status: "unavailable"; detail?: string }
  /** A sub-resource whose parent had no records to try it with. */
  | { status: "unchecked" };

export interface AccessReport {
  access: Record<string, Access>;
  accountName?: string;
}

/**
 * One cheap request per resource, so a missing permission shows up at connect time
 * instead of minutes into an export. Bad credentials and outages still throw.
 */
export async function checkAccess(client: SourceClient, source: SourceDef, names: string[]): Promise<AccessReport> {
  await client.authenticate();
  const access: Record<string, Access> = {};
  const firstIds: Record<string, string | undefined> = {};
  let accountName: string | undefined;

  const ordered = [...names.filter((n) => !source.resources[n]?.parent), ...names.filter((n) => source.resources[n]?.parent)];
  for (const name of ordered) {
    const def = source.resources[name];
    if (!def) continue;
    let path = def.path;
    if (def.parent) {
      const parentAccess = access[def.parent.resource];
      const pid = firstIds[def.parent.resource];
      if (parentAccess && parentAccess.status !== "ok") {
        access[name] = parentAccess.status === "denied" ? { status: "unchecked" } : parentAccess;
        continue;
      }
      if (!pid) {
        access[name] = { status: "unchecked" };
        continue;
      }
      path = def.parent.path(pid);
    }
    if (!path) continue;
    try {
      const records = await client.firstPage(def, path);
      access[name] = { status: "ok" };
      firstIds[name] = records.map((r) => idOf(r, def)).find((id) => id !== undefined);
      if (source.account?.resource === name && records[0]) {
        const n = source.account.name(records[0] as Record<string, unknown>);
        if (typeof n === "string" && n.trim()) accountName = n.trim();
      }
    } catch (e) {
      if (!(e instanceof SourceError)) throw e;
      switch (e.kind) {
        case "forbidden":
          access[name] = { status: "denied", scope: def.scope, detail: e.detail };
          break;
        case "not_found":
        case "bad_request":
          access[name] = { status: "unavailable", detail: e.detail };
          break;
        case "auth":
        case "network":
        case "rate_limited":
        case "server":
        case "protocol":
          throw e;
        default: {
          const never: never = e.kind;
          throw new Error(`Unhandled error kind: ${String(never)}`);
        }
      }
    }
  }
  return { access, accountName };
}
