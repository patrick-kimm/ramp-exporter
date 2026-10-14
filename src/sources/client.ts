import type { Credentials, QueryValue, ResourceDef, SourceDef } from "./types";

export type SourceErrorKind =
  | "auth"
  | "forbidden"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "server"
  | "network"
  | "protocol";

export class SourceError extends Error {
  readonly kind: SourceErrorKind;
  readonly status?: number;
  /** The message without the source's response body appended. */
  readonly summary: string;
  /** The source's own response body, credentials redacted. */
  readonly detail?: string;

  constructor(
    message: string,
    kind: SourceErrorKind,
    opts: { status?: number; detail?: string; sourceLabel?: string } = {},
  ) {
    super(opts.detail ? `${message} — ${opts.sourceLabel ?? "The source"} says: ${opts.detail}` : message);
    this.name = "SourceError";
    this.summary = message;
    this.kind = kind;
    this.status = opts.status;
    this.detail = opts.detail;
  }
}

export interface SourceClientOptions {
  source: SourceDef;
  credentials: Credentials;
  apiBase?: string;
  /** Requested at token time (client-credentials sources only). */
  scopes?: string[];
  rateLimitRps?: number;
  maxRetries?: number;
  signal?: AbortSignal;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Params = Record<string, QueryValue>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Raw-faithful HTTP client shared by every source: auth, throttling, retry with
 * backoff, and each source's pagination style. Records are yielded verbatim — see ADR-0002.
 */
export class SourceClient {
  readonly source: SourceDef;
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private lastRequestAt = 0;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: SourceClientOptions) {
    this.source = opts.source;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.now = opts.now ?? Date.now;
  }

  /** Client-credentials sources exchange key/secret for a token; bearer sources need no round trip. */
  async authenticate(): Promise<void> {
    const auth = this.source.auth;
    switch (auth.kind) {
      case "bearer": {
        const token = this.bearerToken();
        if (!token) throw new SourceError(`Missing ${this.credentialLabel(auth.tokenKey)}.`, "auth");
        this.accessToken = token;
        this.tokenExpiresAt = Number.POSITIVE_INFINITY;
        return;
      }
      case "client_credentials":
        return this.fetchToken(auth.tokenPath, auth.idKey, auth.secretKey);
      default: {
        const never: never = auth;
        throw new Error(`Unhandled auth kind: ${JSON.stringify(never)}`);
      }
    }
  }

  /** Yields every record of a list (or the single record of an object endpoint), verbatim. */
  async *paginate(def: ResourceDef, path: string, params: Params = {}): AsyncGenerator<unknown> {
    const shape = def.shape ?? "page";
    if (shape !== "page") {
      yield* this.unpaged(def, await this.getJson(this.buildUrl(path, params)), path);
      return;
    }

    const pageParams = this.source.pageSize ? { [this.source.pageSize.param]: this.source.pageSize.value } : {};
    let url: string | null = this.buildUrl(path, { ...pageParams, ...params });
    const seen = new Set<string>();
    while (url) {
      this.opts.signal?.throwIfAborted();
      const body = (await this.getJson(url)) as Record<string, unknown> | null;
      const items = this.itemsOf(body, def);
      if (!items) throw this.protocolError(path, `no "${this.itemsKey(def)}" array in the response`);
      yield* items;

      const next = this.nextUrl(body, url);
      if (next && seen.has(next)) throw this.protocolError(path, "the pagination cursor repeated");
      if (next) seen.add(next);
      url = next;
    }
  }

  /** Fetches only the first page with the smallest page size — enough to learn whether the token can read it. */
  async firstPage(def: ResourceDef, path: string): Promise<unknown[]> {
    const shape = def.shape ?? "page";
    const probe = this.source.pageSize && shape === "page" ? { [this.source.pageSize.param]: this.source.pageSize.probe } : {};
    const body = await this.getJson(this.buildUrl(path, { ...(def.query ?? {}), ...probe }));
    if (shape !== "page") return this.unpaged(def, body, path);
    return this.itemsOf(body as Record<string, unknown> | null, def) ?? [];
  }

  private unpaged(def: ResourceDef, body: unknown, path: string): unknown[] {
    const shape = def.shape ?? "page";
    switch (shape) {
      case "object": {
        const record = def.key ? (body as Record<string, unknown> | null)?.[def.key] : body;
        return record == null ? [] : [record];
      }
      case "array":
        if (!Array.isArray(body)) throw this.protocolError(path, "expected a JSON array");
        return body;
      case "list":
      case "page": {
        const items = def.key ? (body as Record<string, unknown> | null)?.[def.key] : undefined;
        if (!Array.isArray(items)) throw this.protocolError(path, `no "${def.key}" array in the response`);
        return items;
      }
      default: {
        const never: never = shape;
        throw new Error(`Unhandled shape: ${String(never)}`);
      }
    }
  }

  private itemsKey(def: ResourceDef): string {
    switch (this.source.pagination.kind) {
      case "next_url":
        return "data";
      case "cursor":
        return "items";
      case "start_after":
      case "page_token":
        return def.key ?? "data";
      default: {
        const never: never = this.source.pagination;
        throw new Error(`Unhandled pagination: ${JSON.stringify(never)}`);
      }
    }
  }

  private itemsOf(body: Record<string, unknown> | null, def: ResourceDef): unknown[] | undefined {
    const items = body?.[this.itemsKey(def)];
    return Array.isArray(items) ? items : undefined;
  }

  private nextUrl(body: Record<string, unknown> | null, current: string): string | null {
    const page = body?.page as Record<string, unknown> | undefined;
    const withParam = (name: string, value: unknown) => {
      if (typeof value !== "string" || value === "") return null;
      const u = new URL(current);
      u.searchParams.set(name, value);
      return u.toString();
    };
    const pagination = this.source.pagination;
    switch (pagination.kind) {
      case "next_url": {
        const next = page?.next;
        return typeof next === "string" && next !== "" ? next : null;
      }
      case "start_after":
        return withParam("start_after", page?.nextPage);
      case "cursor":
        return withParam("cursor", body?.next_cursor);
      case "page_token":
        return withParam("page_token", page?.next_page_token);
      default: {
        const never: never = pagination;
        throw new Error(`Unhandled pagination: ${JSON.stringify(never)}`);
      }
    }
  }

  private async fetchToken(tokenPath: string, idKey: string, secretKey: string): Promise<void> {
    const clientId = this.opts.credentials[idKey]?.trim();
    const clientSecret = this.opts.credentials[secretKey]?.trim();
    if (!clientId || !clientSecret) {
      throw new SourceError(`Missing ${this.credentialLabel(idKey)} or ${this.credentialLabel(secretKey)}.`, "auth");
    }
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({ grant_type: "client_credentials", scope: (this.opts.scopes ?? []).join(" ") });

    const res = await this.send(`${this.base()}${tokenPath}`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    const label = this.source.label;
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      throw new SourceError(`${label} didn't accept these credentials (${res.status})`, "auth", {
        status: res.status,
        detail: await this.errorDetail(res),
        sourceLabel: label,
      });
    }
    if (!res.ok) {
      throw new SourceError(`${label} token request failed (${res.status})`, res.status >= 500 ? "server" : "bad_request", {
        status: res.status,
        detail: await this.errorDetail(res),
        sourceLabel: label,
      });
    }
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new SourceError(`${label} token response had no access_token.`, "protocol");
    this.accessToken = json.access_token;
    this.tokenExpiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
  }

  private bearerToken(): string | undefined {
    const auth = this.source.auth;
    if (auth.kind !== "bearer") return undefined;
    const raw = this.opts.credentials[auth.tokenKey];
    if (!raw) return undefined;
    const cleaned = cleanToken(raw);
    if (!cleaned) return undefined;
    return auth.normalize ? auth.normalize(cleaned) : cleaned;
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || this.now() >= this.tokenExpiresAt - 30_000) await this.authenticate();
  }

  private async getJson(url: string): Promise<unknown> {
    await this.ensureToken();
    const maxRetries = this.opts.maxRetries ?? 6;
    let reauthed = false;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.send(url, {
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
      });
      if (res.ok) {
        try {
          return await res.json();
        } catch {
          throw this.protocolError(url, "the response wasn't JSON");
        }
      }

      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        await this.sleepImpl(this.backoffMs(res, attempt));
        continue;
      }
      // An expired client-credentials token gets one silent refresh.
      if (res.status === 401 && this.source.auth.kind === "client_credentials" && !reauthed) {
        reauthed = true;
        await this.authenticate();
        continue;
      }
      throw await this.httpError(res, url);
    }
  }

  /** fetch with retry on connection failures (not on HTTP errors — getJson owns those). */
  private async send(url: string, init: RequestInit): Promise<Response> {
    const maxRetries = this.opts.maxRetries ?? 6;
    for (let attempt = 0; ; attempt++) {
      this.opts.signal?.throwIfAborted();
      try {
        return await this.fetchImpl(url, { ...init, signal: this.opts.signal });
      } catch (e) {
        if (this.opts.signal?.aborted) throw this.opts.signal.reason ?? e;
        if (attempt >= maxRetries) {
          throw new SourceError(`Couldn't reach ${this.source.label} (${(e as Error).message})`, "network");
        }
        await this.sleepImpl(Math.min(30_000, 2 ** attempt * 500));
      }
    }
  }

  private async httpError(res: Response, url: string): Promise<SourceError> {
    const label = this.source.label;
    const path = this.pathOf(url);
    const detail = await this.errorDetail(res);
    const status = res.status;
    if (status === 401) return new SourceError(`${label} didn't accept these credentials (401)`, "auth", { status, detail, sourceLabel: label });
    const opts = { status, detail, sourceLabel: label };
    if (status === 403) return new SourceError(`${label} denied access to ${path} (403)`, "forbidden", opts);
    if (status === 404) return new SourceError(`${label} has no ${path} for this account (404)`, "not_found", opts);
    if (status === 429) return new SourceError(`${label} kept rate-limiting ${path} (429)`, "rate_limited", opts);
    if (status >= 500) return new SourceError(`${label} had a server error on ${path} (${status})`, "server", opts);
    return new SourceError(`${label} rejected the request to ${path} (${status})`, "bad_request", opts);
  }

  private protocolError(url: string, what: string): SourceError {
    return new SourceError(`Unexpected response from ${this.source.label} for ${this.pathOf(url)}: ${what}`, "protocol");
  }

  /** The source's error body, with every credential and token redacted. */
  private async errorDetail(res: Response): Promise<string | undefined> {
    let body: string;
    try {
      body = (await res.text()).trim();
    } catch {
      return undefined;
    }
    if (!body) return undefined;
    const secrets = [...Object.values(this.opts.credentials), this.accessToken, this.bearerToken()];
    for (const secret of secrets) {
      const s = secret?.trim();
      if (s && s.length >= 4) body = body.split(s).join("[redacted]");
    }
    return body.length > 500 ? `${body.slice(0, 500)}…` : body;
  }

  /** Honor Retry-After when it's a positive number of seconds; otherwise exponential backoff with jitter. */
  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(MAX_RETRY_AFTER_MS, retryAfter * 1000);
    return Math.min(30_000, 2 ** attempt * 250) + Math.floor(Math.random() * 250);
  }

  private async throttle(): Promise<void> {
    const minInterval = 1000 / (this.opts.rateLimitRps ?? this.source.rateLimitRps);
    const wait = this.lastRequestAt + minInterval - this.now();
    if (wait > 0) await this.sleepImpl(wait);
    this.lastRequestAt = this.now();
  }

  private buildUrl(path: string, params: Params): string {
    const url = new URL(`${this.base()}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, v);
    }
    return url.toString();
  }

  private pathOf(url: string): string {
    try {
      const u = new URL(url);
      const base = new URL(this.base()).pathname.replace(/\/$/, "");
      return u.pathname.startsWith(base) ? u.pathname.slice(base.length) || "/" : u.pathname;
    } catch {
      return url;
    }
  }

  private credentialLabel(key: string): string {
    return this.source.credentials.find((c) => c.key === key)?.label ?? key;
  }

  private base(): string {
    return (this.opts.apiBase ?? this.source.apiBase).replace(/\/$/, "");
  }
}

/** Pasted tokens often carry whitespace, quotes, or a `Bearer ` prefix. */
export function cleanToken(raw: string): string {
  return raw
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^bearer\s+/i, "")
    .trim();
}
