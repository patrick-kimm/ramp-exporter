import type { SourceId } from "../src/sources/types";

/** How a mocked endpoint answers. A bare array is a paginated list in the source's style. */
export type MockRoute =
  | unknown[]
  | { list: unknown[]; key?: string; unpaged?: boolean }
  | { object: unknown; key?: string }
  | { array: unknown[] }
  | { status: number; body?: string };

export interface MockSourceOptions {
  style: SourceId;
  /** Path relative to the API base (e.g. "/users", "/account/a1/statements"). */
  routes?: Record<string, MockRoute>;
  /** Fallback: match a paginated list by the last path segment (the old Ramp mock's behavior). */
  bySegment?: Record<string, unknown[]>;
  pageSize?: number;
  /** Return 429 this many times before succeeding (counts down globally). */
  failTimes?: number;
  /** Ramp: the token the token endpoint issues. Others: the bearer token the API accepts. */
  token?: string;
  /** Ramp only: make the token endpoint reject credentials. */
  rejectAuth?: boolean;
  /** Ramp only: make the token endpoint reject with this status and body. */
  rejectAuthWith?: { status: number; body: string };
}

export interface MockSource {
  url: string;
  stop: () => void;
  requests: { method: string; path: string; search: string; auth: string | null }[];
}

const BASE: Record<SourceId, string> = { ramp: "/developer/v1", mercury: "/api/v1", brex: "", rho: "/api/v1" };

/**
 * Hermetic stand-in for any supported source API: an in-process Bun server
 * emulating auth and each source's pagination, so the whole pipeline is tested
 * without the network or real credentials.
 */
export function startMockSource(opts: MockSourceOptions): MockSource {
  const routes = opts.routes ?? {};
  const pageSize = opts.pageSize ?? 2;
  const base = BASE[opts.style];
  const token = opts.token ?? (opts.style === "ramp" ? "test-token" : "test-api-token");
  const requests: MockSource["requests"] = [];
  let remaining429 = opts.failTimes ?? 0;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      const auth = req.headers.get("authorization");
      requests.push({ method: req.method, path: u.pathname, search: u.search, auth });

      if (opts.style === "ramp" && u.pathname === `${base}/token` && req.method === "POST") {
        if (opts.rejectAuthWith) return new Response(opts.rejectAuthWith.body, { status: opts.rejectAuthWith.status });
        if (opts.rejectAuth) return new Response("invalid_client", { status: 401 });
        return Response.json({ access_token: token, expires_in: 3600 });
      }
      if (auth !== `Bearer ${token}`) return new Response('{"error":"unauthorized"}', { status: 401 });

      const path = u.pathname.slice(base.length) || "/";
      const segment = path.split("/").filter(Boolean).pop() ?? "";
      const route: MockRoute | undefined = routes[withQuery(path, u.searchParams)] ?? routes[path] ?? opts.bySegment?.[segment];
      if (route === undefined) return new Response('{"error":"not found"}', { status: 404 });

      if (remaining429 > 0) {
        remaining429--;
        return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
      }

      if (Array.isArray(route)) return page(route, defaultKey(segment), u);
      if ("status" in route) return new Response(route.body ?? "", { status: route.status });
      if ("object" in route) return Response.json(route.key ? { [route.key]: route.object } : route.object);
      if ("array" in route) return Response.json(route.array);
      if (route.unpaged) return Response.json({ [route.key ?? defaultKey(segment)]: route.list });
      return page(route.list, route.key ?? defaultKey(segment), u);
    },
  });

  function page(records: unknown[], key: string, u: URL): Response {
    const cursorParam = { ramp: "start", mercury: "start_after", brex: "cursor", rho: "page_token" }[opts.style];
    const raw = u.searchParams.get(cursorParam);
    const start = raw ? Number(opts.style === "rho" ? atob(raw) : raw.replace(/^after:/, "")) : 0;
    const slice = records.slice(start, start + pageSize);
    const nextStart = start + pageSize;
    const more = nextStart < records.length;
    switch (opts.style) {
      case "ramp": {
        const next = more ? `${u.origin}${u.pathname}?start=${nextStart}` : null;
        return Response.json({ data: slice, page: { next } });
      }
      case "mercury":
        return Response.json({ [key]: slice, page: more ? { nextPage: `after:${nextStart}` } : {} });
      case "brex":
        return Response.json({ items: slice, next_cursor: more ? String(nextStart) : null });
      case "rho":
        return Response.json({ [key]: slice, page: { next_page_token: more ? btoa(String(nextStart)) : null } });
    }
  }

  /** A route keyed like "/users?membership_status=removed" wins when every one of its params matches. */
  function withQuery(path: string, params: URLSearchParams): string {
    for (const key of Object.keys(routes)) {
      const [p, q] = key.split("?");
      if (p !== path || !q) continue;
      if ([...new URLSearchParams(q)].every(([k, v]) => params.get(k) === v)) return key;
    }
    return path;
  }

  return { url: `http://localhost:${server.port}${base}`, stop: () => server.stop(true), requests };
}

function defaultKey(segment: string): string {
  return segment.replace(/-/g, "_");
}
