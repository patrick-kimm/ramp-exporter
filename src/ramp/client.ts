import type { Credentials } from "../config";

export class RampAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RampAuthError";
  }
}

export class RampApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RampApiError";
  }
}

export interface RampClientOptions {
  apiBase: string;
  credentials: Credentials;
  scopes?: string[];
  rateLimitRps?: number;
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  /** TODO-VERIFY: confirm Ramp's token endpoint path against live docs. */
  tokenPath?: string;
}

/** Ramp cursor-paginated list response. TODO-VERIFY exact shape against live API. */
interface Page {
  data?: unknown[];
  page?: { next?: string | null };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Minimal raw-faithful Ramp API client: OAuth2 client-credentials auth, a
 * cursor paginator that yields records verbatim, rate limiting, and retry with
 * backoff. It does NOT shape data toward our model — see ADR-0002.
 */
export class RampClient {
  private accessToken?: string;
  private tokenExpiresAt = 0;
  private lastRequestAt = 0;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: RampClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleepImpl = opts.sleepImpl ?? sleep;
    this.now = opts.now ?? Date.now;
  }

  async authenticate(): Promise<void> {
    const { clientId, clientSecret } = this.opts.credentials;
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      scope: (this.opts.scopes ?? []).join(" "),
    });

    const res = await this.fetchImpl(this.tokenUrl(), {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });

    if (res.status === 401 || res.status === 403) {
      throw new RampAuthError(
        `Ramp auth failed (${res.status}). Check RAMP_CLIENT_ID / RAMP_CLIENT_SECRET and that the app has the requested read scopes.`,
      );
    }
    if (!res.ok) {
      throw new RampApiError(`Ramp token request failed (${res.status})`, res.status);
    }

    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new RampAuthError("Ramp token response missing access_token.");
    this.accessToken = json.access_token;
    this.tokenExpiresAt = this.now() + (json.expires_in ?? 3600) * 1000;
  }

  /** Yields every record across all pages of a list endpoint, verbatim. */
  async *paginate(path: string, params: Record<string, string> = {}): AsyncGenerator<unknown> {
    await this.ensureToken();
    let url: string | null = this.buildUrl(path, params);
    while (url) {
      const page = (await this.getJson(url)) as Page;
      for (const record of page.data ?? []) yield record;
      url = page.page?.next ?? null; // TODO-VERIFY pagination cursor shape
    }
  }

  private async ensureToken(): Promise<void> {
    if (!this.accessToken || this.now() >= this.tokenExpiresAt - 30_000) {
      await this.authenticate();
    }
  }

  private async getJson(url: string): Promise<unknown> {
    const maxRetries = this.opts.maxRetries ?? 6;
    for (let attempt = 0; ; attempt++) {
      await this.throttle();
      const res = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${this.accessToken}`, Accept: "application/json" },
      });

      if (res.ok) return res.json();

      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < maxRetries) {
        await this.sleepImpl(this.backoffMs(res, attempt));
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new RampAuthError(`Unauthorized (${res.status}) for ${url}`);
      }
      throw new RampApiError(`Ramp API error ${res.status} for ${url}`, res.status);
    }
  }

  /** Honor Retry-After when present; otherwise exponential backoff with jitter. */
  private backoffMs(res: Response, attempt: number): number {
    const retryAfter = Number(res.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
    return Math.min(30_000, 2 ** attempt * 250) + Math.floor(Math.random() * 250);
  }

  private async throttle(): Promise<void> {
    const minInterval = 1000 / (this.opts.rateLimitRps ?? 8);
    const wait = this.lastRequestAt + minInterval - this.now();
    if (wait > 0) await this.sleepImpl(wait);
    this.lastRequestAt = this.now();
  }

  private tokenUrl(): string {
    return this.opts.tokenPath ?? `${this.base()}/token`;
  }

  private buildUrl(path: string, params: Record<string, string>): string {
    const url = new URL(`${this.base()}${path.startsWith("/") ? path : `/${path}`}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return url.toString();
  }

  private base(): string {
    return this.opts.apiBase.replace(/\/$/, "");
  }
}
