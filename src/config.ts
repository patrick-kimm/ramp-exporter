import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { SOURCE_IDS, type Credentials, type SourceDef, type SourceId } from "./sources/types";

/**
 * config.yml schema. Secrets NEVER live here — credentials come from env
 * (see loadCredentials). This mirrors config.example.yml.
 */
export const ConfigSchema = z.object({
  format_version: z.string().default("1.1"),
  source: z
    .object({
      system: z.enum(SOURCE_IDS as [SourceId, ...SourceId[]]).default("ramp"),
      /** Defaults to the source's production API. */
      api_base: z.string().url().optional(),
      /** Client-credentials sources only (Ramp). Defaults to every scope the export needs. */
      scopes: z.array(z.string()).optional(),
    })
    .default({}),
  export: z
    .object({
      /** Category ids from the source (see `ramp-exporter sources`). Defaults to all of them. */
      categories: z.array(z.string()).min(1).optional(),
      mode: z.literal("full").default("full"), // v1: full snapshots only
      filters: z
        .object({
          date_range: z.object({ from: z.string(), to: z.string() }).optional(),
        })
        .default({}),
    })
    .default({}),
  output: z
    .object({
      backend: z.literal("local").default("local"), // v1: local only
      path: z.string().default("./exports"),
    })
    .default({}),
  runtime: z
    .object({
      /** Defaults to a pace each source is comfortable with. */
      rate_limit_rps: z.number().positive().optional(),
      max_retries: z.number().int().nonnegative().default(6),
      log_format: z.enum(["text", "json"]).default("text"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function parseConfig(raw: unknown): Config {
  return ConfigSchema.parse(dropNulls(raw) ?? {});
}

/** A YAML key left empty (e.g. every child commented out) parses as null; treat it as absent. */
function dropNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value)) return value.map(dropNulls);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => (v === null ? [] : [[k, dropNulls(v)]])));
  }
  return value;
}

/** Reads config.yml. A missing file is fine only when the caller didn't name one explicitly. */
export function loadConfig(path: string, { required = true } = {}): Config {
  if (!existsSync(path)) {
    if (required) throw new Error(`Config file not found: ${path}`);
    return parseConfig({});
  }
  return parseConfig(parseYaml(readFileSync(path, "utf8")));
}

/** Credentials come from the environment only — never config.yml, never our SaaS. */
export function loadCredentials(source: SourceDef, env: Record<string, string | undefined> = process.env): Credentials {
  const credentials: Credentials = {};
  const missing: string[] = [];
  for (const field of source.credentials) {
    const value = env[field.env]?.trim();
    if (value) credentials[field.key] = value;
    else missing.push(field.env);
  }
  if (missing.length) {
    throw new Error(`Missing ${source.label} credentials: set ${missing.join(" and ")} (see .env.example).`);
  }
  return credentials;
}
