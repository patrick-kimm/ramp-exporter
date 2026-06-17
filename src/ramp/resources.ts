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
  // Slice 1: departments, locations
  // Slice 2: cards, spend_limits, spend_programs
  // Slice 3: vendors, bills, transactions
};

/** Which raw resources each export category pulls. */
export const CATEGORY_RESOURCES: Record<Category, string[]> = {
  users: ["users"], // Slice 0: users only; +departments,+locations in Slice 1
  cards: [], // Slice 2
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
