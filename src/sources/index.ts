import { brex } from "./brex";
import { mercury } from "./mercury";
import { ramp } from "./ramp";
import { rho } from "./rho";
import type { SourceDef, SourceId } from "./types";

export const SOURCES: Record<SourceId, SourceDef> = { ramp, mercury, brex, rho };

export function getSource(id: SourceId): SourceDef {
  return SOURCES[id];
}

/** The resource names a set of categories expands to, in the source's declared order. */
export function resourcesForCategories(source: SourceDef, categories: string[]): string[] {
  const wanted = new Set(categories);
  return source.categories.filter((c) => wanted.has(c.id)).flatMap((c) => c.resources);
}

export * from "./types";
