import { parseConfig, type Config } from "../src/config";
import { SourceClient } from "../src/sources/client";
import { getSource } from "../src/sources";
import { scopesFor, type Credentials, type SourceId } from "../src/sources/types";

export const RAMP_CREDS: Credentials = { clientId: "id", clientSecret: "secret" };
export const TOKEN_CREDS: Credentials = { apiToken: "test-api-token" };

export function credsFor(id: SourceId): Credentials {
  return id === "ramp" ? RAMP_CREDS : TOKEN_CREDS;
}

/** A client with no pacing or real sleeps, for hermetic tests. */
export function fastClient(id: SourceId, apiBase: string, credentials: Credentials = credsFor(id), signal?: AbortSignal) {
  const source = getSource(id);
  return new SourceClient({
    source,
    apiBase,
    credentials,
    scopes: scopesFor(source),
    rateLimitRps: 10_000,
    maxRetries: 3,
    sleepImpl: async () => {},
    signal,
  });
}

export function cfg(
  id: SourceId,
  out: string,
  apiBase: string | undefined,
  exportOpts: { categories?: string[]; date_range?: { from: string; to: string } } = {},
): Config {
  return parseConfig({
    source: { system: id, api_base: apiBase },
    export: {
      categories: exportOpts.categories,
      filters: exportOpts.date_range ? { date_range: exportOpts.date_range } : {},
    },
    output: { path: out },
    runtime: { rate_limit_rps: 10_000, max_retries: 3 },
  });
}

export function readJsonl(text: string): Record<string, unknown>[] {
  return text
    .trimEnd()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
