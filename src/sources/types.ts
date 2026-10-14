export type SourceId = "ramp" | "mercury" | "brex" | "rho";

export const SOURCE_IDS: readonly SourceId[] = ["ramp", "mercury", "brex", "rho"];

export function isSourceId(v: unknown): v is SourceId {
  return typeof v === "string" && (SOURCE_IDS as readonly string[]).includes(v);
}

/** One value the customer pastes in (UI field + env var for the CLI). */
export interface CredentialField {
  key: string;
  label: string;
  env: string;
  secret: boolean;
  placeholder?: string;
}

export type Credentials = Record<string, string>;

export type AuthDef =
  /** OAuth2 client-credentials: exchange key/secret for a short-lived bearer token. Scopes are checked at token time. */
  | { kind: "client_credentials"; tokenPath: string; idKey: string; secretKey: string }
  /** A long-lived token the customer creates in the dashboard and pastes in. */
  | { kind: "bearer"; tokenKey: string; normalize?: (token: string) => string };

/** Where a page's records live, and how to ask for the next page. */
export type Pagination =
  /** Ramp: `{ data: [], page: { next: <absolute url> } }`. */
  | { kind: "next_url" }
  /** Mercury: `{ <key>: [], page: { nextPage: <id> } }`, next page via `start_after=<id>`. */
  | { kind: "start_after" }
  /** Brex: `{ items: [], next_cursor }`, next page via `cursor=`. */
  | { kind: "cursor" }
  /** Rho: `{ <key>: [], page: { next_page_token } }`, next page via `page_token=`. */
  | { kind: "page_token" };

export type DateFormat =
  /** YYYY-MM-DD, bound included. */
  | "date"
  /** YYYY-MM-DD, upper bound excluded (we pass the day after). */
  | "date_exclusive"
  /** ISO datetime; start of day for `from`, end of day for `to`. */
  | "datetime"
  /** ISO datetime, upper bound excluded (we pass midnight of the day after). */
  | "datetime_exclusive";

export interface DateFilter {
  from?: { param: string; format: DateFormat };
  to?: { param: string; format: DateFormat };
  /** When the API has no upper-bound param, drop records whose YYYY-MM-DD `field` is after `to`. */
  clientTo?: string;
}

export type QueryValue = string | string[];

export interface ResourceDef {
  label: string;
  /** Singular, for the record drawer. */
  one: string;
  /** List endpoint path. Omitted for sub-resources (see `parent`). */
  path?: string;
  /** The token permission this endpoint needs; named in the UI when access is denied. */
  scope?: string;
  /**
   * `page` (default): a paginated list. `list`: `{ <key>: [] }` in one response, no paging.
   * `object`: a single record. `array`: a bare JSON array.
   */
  shape?: "page" | "list" | "object" | "array";
  /** Key holding the records (Mercury/Rho), or the single object for `shape: "object"`. */
  key?: string;
  /** Stable record id, used to de-duplicate and to link sub-resources. Defaults to `id`. */
  idField?: string;
  /** Fixed query params sent with every request. */
  query?: Record<string, QueryValue>;
  dateFilter?: DateFilter;
  /** Fetched once per parent record; the parent id is injected into each row as `linkField`. */
  parent?: { resource: string; path: (parentId: string) => string; linkField: string };
  /** Contains full bank account numbers. */
  sensitive?: boolean;
}

export interface CategoryDef {
  id: string;
  label: string;
  description: string;
  resources: string[];
}

export interface SetupGuide {
  url: string;
  linkLabel: string;
  steps: string[];
  /** Shown under the last step, e.g. which scopes to enable. */
  scopesNote?: string;
}

export interface SourceDef {
  id: SourceId;
  label: string;
  tagline: string;
  /** Recorded in the manifest. */
  apiVersion: string;
  apiBase: string;
  /** Env var that overrides `apiBase` (sandboxes, tests). */
  apiBaseEnv: string;
  /** Steady request rate we stay under. */
  rateLimitRps: number;
  credentials: CredentialField[];
  auth: AuthDef;
  pagination: Pagination;
  /** Page-size param: `value` for exports, `probe` for the cheap access check at connect time. */
  pageSize?: { param: string; value: string; probe: string };
  resources: Record<string, ResourceDef>;
  categories: CategoryDef[];
  setup: SetupGuide;
  /** Which resource names the connected company, and how to read the name from its first record. */
  account?: { resource: string; name: (record: Record<string, unknown>) => unknown };
}

/** Every scope the source's resources need, in declaration order. */
export function scopesFor(source: SourceDef): string[] {
  return [...new Set(Object.values(source.resources).flatMap((r) => (r.scope ? [r.scope] : [])))];
}
