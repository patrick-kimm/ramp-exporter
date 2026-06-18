import type { RampClient } from "./client";
import type { Category } from "../manifest";

export interface ResourceDef {
  /** Ramp list endpoint path (verified — see docs/ramp-api-notes.md). Omitted for sub-resources (use `parent`). */
  path?: string;
  scope: string;
  /** If the endpoint supports date filtering, the query params the config date_range maps to. */
  dateParams?: { from: string; to: string };
  /** Fetched once per parent record (e.g. /vendors/{id}/contacts); the parent id is injected as `linkField`. */
  parent?: { resource: string; subPath: (parentId: string) => string; linkField: string };
}

/**
 * Registry of raw Ramp resources. Adding a resource is a one-line change here
 * plus mapping it into a category below — that cheapness is the whole point of
 * the Slice-0 spine.
 */
export const RESOURCES: Record<string, ResourceDef> = {
  users: { path: "/users", scope: "users:read" },
  departments: { path: "/departments", scope: "departments:read" },
  locations: { path: "/locations", scope: "locations:read" },
  entities: { path: "/entities", scope: "entities:read" }, // referenced everywhere via entity_id
  cards: { path: "/cards", scope: "cards:read" },
  // NB: /limits is the LEGACY alias of /funds (same entities, renamed fields) — we export funds only.
  "spend-programs": { path: "/spend-programs", scope: "spend_programs:read" },
  funds: { path: "/funds", scope: "funds:read" }, // virtual-account / subaccount buckets (balance, members, cards[])
  vendors: { path: "/vendors", scope: "vendors:read" }, // bill-pay vendors (has bank accounts, masked)
  vendor_contacts: {
    scope: "vendors:read",
    parent: { resource: "vendors", subPath: (id) => `/vendors/${id}/contacts`, linkField: "vendor_id" },
  },
  bills: {
    path: "/bills",
    scope: "bills:read",
    dateParams: { from: "from_issued_date", to: "to_issued_date" },
  },
  transactions: {
    path: "/transactions",
    scope: "transactions:read",
    dateParams: { from: "from_date", to: "to_date" },
  },
};

/** Which raw resources each export category pulls. */
export const CATEGORY_RESOURCES: Record<Category, string[]> = {
  users: ["users", "departments", "locations", "entities"],
  cards: ["cards", "spend-programs", "funds"],
  vendors: ["vendors", "vendor_contacts", "bills", "transactions"],
};

/** Ramp's date filters require a full ISO-8601 datetime, not a bare YYYY-MM-DD (returns 422 otherwise). */
export function toRampDatetime(value: string, bound: "start" | "end"): string {
  if (value.includes("T")) return value; // already a datetime — pass through
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return bound === "start" ? `${value}T00:00:00Z` : `${value}T23:59:59Z`;
  }
  return value; // unrecognized; let Ramp validate
}

/** Collect every record of a resource (raw-faithful, full snapshot). */
export async function fetchResource(
  client: RampClient,
  name: string,
  dateRange?: { from: string; to: string },
): Promise<unknown[]> {
  const def = RESOURCES[name];
  if (!def) throw new Error(`Unknown resource: ${name}`);
  if (!def.path) throw new Error(`${name} is a sub-resource — fetch it via fetchSubResource`);
  const params: Record<string, string> = {};
  if (def.dateParams && dateRange) {
    params[def.dateParams.from] = toRampDatetime(dateRange.from, "start");
    params[def.dateParams.to] = toRampDatetime(dateRange.to, "end");
  }
  const records: unknown[] = [];
  for await (const record of client.paginate(def.path, params)) records.push(record);
  return records;
}

/** Fetched once per parent record (e.g. /vendors/{id}/contacts). Injects the parent id as the link field. */
export async function fetchSubResource(
  client: RampClient,
  name: string,
  parentRecords: unknown[],
): Promise<unknown[]> {
  const def = RESOURCES[name];
  if (!def?.parent) throw new Error(`${name} is not a sub-resource`);
  const { subPath, linkField } = def.parent;
  const out: unknown[] = [];
  for (const parent of parentRecords) {
    const pid = (parent as Record<string, unknown>).id;
    if (typeof pid !== "string") continue;
    for await (const record of client.paginate(subPath(pid))) {
      out.push({ [linkField]: pid, ...(record as Record<string, unknown>) });
    }
  }
  return out;
}

export function resourcesForCategories(categories: Category[]): string[] {
  return categories.flatMap((c) => CATEGORY_RESOURCES[c] ?? []);
}
