import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * config.yml schema. Secrets NEVER live here — credentials come from env
 * (see loadCredentials). This mirrors config.example.yml.
 */
export const ConfigSchema = z.object({
  format_version: z.string().default("1.0"),
  source: z.object({
    api_base: z.string().url(),
    scopes: z.array(z.string()).default([]),
  }),
  export: z.object({
    categories: z.array(z.enum(["users", "cards", "vendors"])).min(1),
    mode: z.literal("full").default("full"), // v1: full snapshots only
    filters: z
      .object({
        date_range: z.object({ from: z.string(), to: z.string() }).optional(),
      })
      .default({}),
  }),
  output: z.object({
    backend: z.literal("local").default("local"), // v1: local only
    path: z.string().default("./exports"),
  }),
  runtime: z
    .object({
      rate_limit_rps: z.number().positive().default(8),
      max_retries: z.number().int().nonnegative().default(6),
      log_format: z.enum(["text", "json"]).default("text"),
    })
    .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path: string): Config {
  const raw = readFileSync(path, "utf8");
  return ConfigSchema.parse(parseYaml(raw));
}

export interface Credentials {
  clientId: string;
  clientSecret: string;
}

/** Ramp credentials come from the environment only — never config.yml, never our SaaS. */
export function loadCredentials(
  env: Record<string, string | undefined> = process.env,
): Credentials {
  const clientId = env.RAMP_CLIENT_ID;
  const clientSecret = env.RAMP_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Missing Ramp credentials: set RAMP_CLIENT_ID and RAMP_CLIENT_SECRET (see .env.example).",
    );
  }
  return { clientId, clientSecret };
}
