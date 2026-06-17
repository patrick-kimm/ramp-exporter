import type { RampClient } from "./client";
import type { Category } from "../manifest";

export interface ResourceDef {
  /** Ramp list endpoint path. TODO-VERIFY paths/scopes against live docs. */
  path: string;
  scope: string;
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
  cards: { path: "/cards", scope: "cards:read" },
  limits: { path: "/limits", scope: "limits:read" }, // Ramp "spend limits"
  "spend-programs": { path: "/spend-programs", scope: "spend_programs:read" },
  // Slice 3: vendors, bills, transactions
};

/** Which raw resources each export category pulls. */
export const CATEGORY_RESOURCES: Record<Category, string[]> = {
  users: ["users", "departments", "locations"],
  cards: ["cards", "limits", "spend-programs"],
  vendors: [], // Slice 3
};

/** Collect every record of a resource (raw-faithful, full snapshot). */
export async function fetchResource(client: RampClient, name: string): Promise<unknown[]> {
  const def = RESOURCES[name];
  if (!def) throw new Error(`Unknown resource: ${name}`);
  const records: unknown[] = [];
  for await (const record of client.paginate(def.path)) records.push(record);
  return records;
}

export function resourcesForCategories(categories: Category[]): string[] {
  return categories.flatMap((c) => CATEGORY_RESOURCES[c] ?? []);
}
