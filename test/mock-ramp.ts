export interface MockRamp {
  url: string;
  stop: () => void;
  requests: { method: string; path: string }[];
}

export interface MockRampOptions {
  users?: unknown[];
  pageSize?: number;
  /** Return 429 this many times (on the users endpoint) before succeeding. */
  failTimes?: number;
  validToken?: string;
  /** Make the token endpoint reject credentials. */
  rejectAuth?: boolean;
}

/**
 * Hermetic stand-in for the Ramp API: an in-process Bun server emulating the
 * token endpoint, bearer auth, and cursor pagination. Lets the whole spine be
 * tested without touching the network or real credentials.
 */
export function startMockRamp(opts: MockRampOptions = {}): MockRamp {
  const users = opts.users ?? [];
  const pageSize = opts.pageSize ?? 2;
  const token = opts.validToken ?? "test-token";
  const requests: { method: string; path: string }[] = [];
  let remaining429 = opts.failTimes ?? 0;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      requests.push({ method: req.method, path: u.pathname });

      if (u.pathname.endsWith("/token") && req.method === "POST") {
        if (opts.rejectAuth) return new Response("invalid_client", { status: 401 });
        return Response.json({ access_token: token, expires_in: 3600 });
      }

      if (req.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("unauthorized", { status: 401 });
      }

      if (u.pathname.endsWith("/users")) {
        if (remaining429 > 0) {
          remaining429--;
          return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
        }
        const start = Number(u.searchParams.get("start") ?? "0");
        const slice = users.slice(start, start + pageSize);
        const nextStart = start + pageSize;
        const next =
          nextStart < users.length ? `${u.origin}/developer/v1/users?start=${nextStart}` : null;
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
