export interface MockRamp {
  url: string;
  stop: () => void;
  requests: { method: string; path: string; search: string }[];
}

export interface MockRampOptions {
  /** resource name (last path segment) -> all of its records */
  resources?: Record<string, unknown[]>;
  pageSize?: number;
  /** Return 429 this many times before succeeding (counts down globally). */
  failTimes?: number;
  validToken?: string;
  /** Make the token endpoint reject credentials. */
  rejectAuth?: boolean;
}

/**
 * Hermetic stand-in for the Ramp API: an in-process Bun server emulating the
 * token endpoint, bearer auth, and cursor pagination for any resource. Lets the
 * whole spine be tested without touching the network or real credentials.
 */
export function startMockRamp(opts: MockRampOptions = {}): MockRamp {
  const resources = opts.resources ?? {};
  const pageSize = opts.pageSize ?? 2;
  const token = opts.validToken ?? "test-token";
  const requests: { method: string; path: string; search: string }[] = [];
  let remaining429 = opts.failTimes ?? 0;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      requests.push({ method: req.method, path: u.pathname, search: u.search });

      if (u.pathname.endsWith("/token") && req.method === "POST") {
        if (opts.rejectAuth) return new Response("invalid_client", { status: 401 });
        return Response.json({ access_token: token, expires_in: 3600 });
      }

      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }

      const name = u.pathname.split("/").filter(Boolean).pop() ?? "";
      const records = resources[name];
      if (records) {
        if (remaining429 > 0) {
          remaining429--;
          return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        }
        const start = Number(u.searchParams.get("start") ?? "0");
        const slice = records.slice(start, start + pageSize);
        const nextStart = start + pageSize;
        const next =
          nextStart < records.length ? `${u.origin}/developer/v1/${name}?start=${nextStart}` : null;
        return Response.json({ data: slice, page: { next } });
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}/developer/v1`,
    stop: () => server.stop(true),
    requests,
  };
}
