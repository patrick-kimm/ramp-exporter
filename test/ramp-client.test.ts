import { describe, expect, test } from "bun:test";
import { SourceClient, SourceError } from "../src/sources/client";
import { ramp } from "../src/sources/ramp";
import { fastClient } from "./helpers";
import { startMockRamp } from "./mock-ramp";

const users = ramp.resources.users!;

describe("SourceClient (Ramp)", () => {
  test("authenticates and paginates across all pages, verbatim", async () => {
    const records = [{ id: "u1" }, { id: "u2" }, { id: "u3" }, { id: "u4" }, { id: "u5" }];
    const mock = startMockRamp({ resources: { users: records }, pageSize: 2 });
    try {
      const client = fastClient("ramp", mock.url);
      const out: unknown[] = [];
      for await (const r of client.paginate(users, "/users")) out.push(r);
      expect(out).toEqual(records);
      // 3 pages (2+2+1), the first asking for the export page size
      const pages = mock.requests.filter((r) => r.path.endsWith("/users"));
      expect(pages.length).toBe(3);
      expect(new URLSearchParams(pages[0]!.search).get("page_size")).toBe("100");
    } finally {
      mock.stop();
    }
  });

  test("retries on 429 then succeeds", async () => {
    const mock = startMockRamp({ resources: { users: [{ id: "u1" }] }, failTimes: 2 });
    try {
      const out: unknown[] = [];
      for await (const r of fastClient("ramp", mock.url).paginate(users, "/users")) out.push(r);
      expect(out).toEqual([{ id: "u1" }]);
    } finally {
      mock.stop();
    }
  });

  test("gives up after maxRetries with a rate_limited SourceError", async () => {
    const mock = startMockRamp({ resources: { users: [{ id: "u1" }] }, failTimes: 99 });
    try {
      const run = async () => {
        for await (const _ of fastClient("ramp", mock.url).paginate(users, "/users")) void _;
      };
      const err = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect((err as SourceError).kind).toBe("rate_limited");
    } finally {
      mock.stop();
    }
  });

  test("bad credentials are an auth error", async () => {
    const mock = startMockRamp({ rejectAuth: true });
    try {
      const err = await fastClient("ramp", mock.url).authenticate().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(SourceError);
      expect((err as SourceError).kind).toBe("auth");
      expect((err as SourceError).status).toBe(401);
    } finally {
      mock.stop();
    }
  });

  test("auth errors surface Ramp's reason with credentials redacted", async () => {
    const realCreds = { clientId: "ramp_id_testClient123", clientSecret: "ramp_sec_testSecret456" };
    const mock = startMockRamp({
      rejectAuthWith: {
        status: 403,
        body: `{"error":"invalid_scope","error_description":"funds:read not allowed for this client (${realCreds.clientSecret})"}`,
      },
    });
    try {
      const err = (await fastClient("ramp", mock.url, realCreds).authenticate().catch((e: unknown) => e)) as SourceError;
      expect(err.kind).toBe("auth");
      expect(err.message).toContain("Ramp didn't accept these credentials (403)");
      expect(err.message).toContain("Ramp says:");
      expect(err.detail).toContain("funds:read not allowed for this client ([redacted])");
      expect(err.message).not.toContain(realCreds.clientSecret);
    } finally {
      mock.stop();
    }
  });

  test("a repeating cursor is a protocol error, not an infinite loop", async () => {
    let calls = 0;
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port: 0,
      fetch(req): Response {
        if (new URL(req.url).pathname.endsWith("/token")) return Response.json({ access_token: "t", expires_in: 3600 });
        calls++;
        return Response.json({ data: [{ id: `u${calls}` }], page: { next: `http://localhost:${server.port}/v1/users?start=same` } });
      },
    });
    try {
      const client = fastClient("ramp", `http://localhost:${server.port}/v1`);
      const run = async () => {
        for await (const _ of client.paginate(users, "/users")) void _;
      };
      const err = (await run().catch((e: unknown) => e)) as SourceError;
      expect(err.kind).toBe("protocol");
      expect(calls).toBe(2);
    } finally {
      server.stop(true);
    }
  });

  test("connection failures are retried, then reported as network errors", async () => {
    let attempts = 0;
    const client = new SourceClient({
      source: ramp,
      credentials: { clientId: "id", clientSecret: "secret" },
      maxRetries: 2,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        attempts++;
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    const err = (await client.authenticate().catch((e: unknown) => e)) as SourceError;
    expect(err.kind).toBe("network");
    expect(attempts).toBe(3);
  });

  test("an expired token is refreshed once on 401", async () => {
    let tokens = 0;
    let served = false;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith("/token")) return Response.json({ access_token: `t${++tokens}`, expires_in: 3600 });
        if (!served) {
          served = true;
          return new Response("expired", { status: 401 });
        }
        return Response.json({ data: [{ id: "u1" }], page: { next: null } });
      },
    });
    try {
      const out: unknown[] = [];
      for await (const r of fastClient("ramp", `http://localhost:${server.port}/v1`).paginate(users, "/users")) out.push(r);
      expect(out).toEqual([{ id: "u1" }]);
      expect(tokens).toBe(2);
    } finally {
      server.stop(true);
    }
  });
});
