import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer } from "../src/ui/server";
import { startMockRamp } from "./mock-ramp";
import { startMockSource } from "./mock-source";

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return res;
}

const FAST = 10_000;

describe("ui server", () => {
  test("GET / serves the page", async () => {
    const ui = startUiServer({ port: 0 });
    try {
      const res = await fetch(`${ui.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("/api/sources");
      expect(html).toContain("/api/export");
    } finally {
      ui.stop();
    }
  });

  test("GET /api/sources describes all four platforms without leaking functions", async () => {
    const ui = startUiServer({ port: 0 });
    try {
      const { sources } = await (await fetch(`${ui.url}/api/sources`)).json();
      expect(sources.map((s: { id: string }) => s.id)).toEqual(["ramp", "mercury", "brex", "rho"]);
      const mercury = sources[1];
      expect(mercury.credentials).toEqual([expect.objectContaining({ key: "apiToken", secret: true })]);
      expect(mercury.resources.statements).toEqual(expect.objectContaining({ parent: "accounts" }));
      expect(mercury.resources.transactions.dated).toBe(true);
      expect(mercury.resources.recipients.sensitive).toBe(true);
      expect(sources[0].scopes).toHaveLength(10);
      expect(JSON.stringify(sources)).not.toContain("=>");
    } finally {
      ui.stop();
    }
  });

  test("POST /api/export (Ramp, legacy body) runs the export and returns a preview", async () => {
    const mock = startMockRamp({
      resources: {
        users: [{ id: "u1", department_id: "d1" }, { id: "u2", department_id: "d2" }],
        departments: [{ id: "d1", name: "Eng" }, { id: "d2", name: "Ops" }],
        locations: [],
        entities: [],
      },
      pageSize: 50,
    });
    const out = await mkdtemp(join(tmpdir(), "ui-out-"));
    const ui = startUiServer({ port: 0, apiBases: { ramp: mock.url }, outputPath: out, rateLimitRps: FAST });
    try {
      const data = await (await post(ui.url, "/api/export", { clientId: "id", clientSecret: "secret", categories: ["users"] })).json();
      expect(data.ok).toBe(true);
      expect(data.source).toBe("ramp");
      expect(data.status).toBe("complete");
      expect(data.counts.users).toBe(2);
      expect(data.resources.users[0].id).toBe("u1");
      expect(data.bundleDir.startsWith(join(out, "ramp"))).toBe(true);
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/export (Mercury) streams progress and reports skipped resources", async () => {
    const mock = startMockSource({
      style: "mercury",
      token: "secret-token:tok",
      routes: {
        "/organization": { object: { id: "o" }, key: "organization" },
        "/users": { status: 403, body: "nope" },
      },
    });
    const out = await mkdtemp(join(tmpdir(), "ui-out-"));
    const ui = startUiServer({ port: 0, apiBases: { mercury: mock.url }, outputPath: out, rateLimitRps: FAST });
    try {
      const res = await post(
        ui.url,
        "/api/export",
        { source: "mercury", credentials: { apiToken: "tok" }, categories: ["users"] },
        { accept: "application/x-ndjson" },
      );
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(events[0]).toEqual({ type: "plan", resources: ["organization", "users"] });
      expect(events).toContainEqual(expect.objectContaining({ type: "resource_skipped", resource: "users", status: "skipped" }));
      const result = events.at(-1);
      expect(result).toMatchObject({ type: "result", ok: true, source: "mercury", status: "partial", counts: { organization: 1, users: 0 } });
      expect(result.skipped.users.status).toBe("skipped");
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/export streams per-resource progress for sub-resources", async () => {
    const mock = startMockRamp({
      resources: { vendors: [{ id: "v1" }, { id: "v2" }], contacts: [{ id: "c1" }], bills: [{ id: "b1" }], transactions: [] },
      pageSize: 50,
    });
    const out = await mkdtemp(join(tmpdir(), "ui-out-"));
    const ui = startUiServer({ port: 0, apiBases: { ramp: mock.url }, outputPath: out, rateLimitRps: FAST });
    try {
      const res = await post(
        ui.url,
        "/api/export",
        { source: "ramp", credentials: { clientId: "id", clientSecret: "secret" }, categories: ["vendors"] },
        { accept: "application/x-ndjson" },
      );
      const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
      expect(events[0]).toEqual({ type: "plan", resources: ["vendors", "vendor_contacts", "bills", "transactions"] });
      expect(events).toContainEqual({ type: "resource_progress", resource: "vendor_contacts", done: 2, total: 2 });
      expect(events.at(-1).counts).toEqual({ vendors: 2, vendor_contacts: 2, bills: 1, transactions: 0 });
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/connect returns an access report and the account name", async () => {
    const mock = startMockSource({
      style: "rho",
      routes: {
        "/business": { object: { legal_name: "Acme LLC" } },
        "/users": [{ id: "u1" }],
        "/cards": { status: 403, body: '{"type":"about:blank","title":"Forbidden"}' },
      },
    });
    const ui = startUiServer({ port: 0, apiBases: { rho: mock.url }, rateLimitRps: FAST });
    try {
      const data = await (await post(ui.url, "/api/connect", { source: "rho", credentials: { apiToken: "test-api-token" } })).json();
      expect(data.ok).toBe(true);
      expect(data.accountName).toBe("Acme LLC");
      expect(data.access.users).toEqual({ status: "ok" });
      expect(data.access.cards).toMatchObject({ status: "denied", scope: "cards:read" });
      expect(data.access.invoices.status).toBe("unavailable");
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/connect names the missing scope from Ramp's 403, with Ramp's text in detail", async () => {
    const mock = startMockRamp({
      rejectAuthWith: { status: 403, body: '{"error":"invalid_scope","error_description":"Scope funds:read is not enabled"}' },
    });
    const ui = startUiServer({ port: 0, apiBases: { ramp: mock.url }, rateLimitRps: FAST });
    try {
      const data = await (await post(ui.url, "/api/connect", { clientId: "ramp_id_testClient123", clientSecret: "ramp_sec_testSecret456" })).json();
      expect(data.ok).toBe(false);
      expect(data.kind).toBe("auth");
      expect(data.status).toBe(403);
      expect(data.missingScopes).toEqual(["funds:read"]);
      expect(data.detail).toContain("invalid_scope");
      expect(data.error).not.toContain("Ramp says");
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/connect with a bad bearer token is an auth error", async () => {
    const mock = startMockSource({ style: "brex", routes: { "/v2/company": { object: {} } } });
    const ui = startUiServer({ port: 0, apiBases: { brex: mock.url }, rateLimitRps: FAST });
    try {
      const data = await (await post(ui.url, "/api/connect", { source: "brex", credentials: { apiToken: "wrong" } })).json();
      expect(data).toMatchObject({ ok: false, kind: "auth", status: 401 });
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/export validates the request before touching the source", async () => {
    const ui = startUiServer({ port: 0, apiBases: { brex: "http://localhost:1" } });
    const creds = { source: "brex", credentials: { apiToken: "x" } };
    try {
      const cases: [unknown, RegExp][] = [
        [{ categories: ["users"] }, /required/],
        [{ source: "chase", credentials: {}, categories: ["users"] }, /Unknown source/],
        [{ ...creds, categories: [] }, /at least one/],
        [{ ...creds, categories: ["invoicing"] }, /Brex has no invoicing/],
        [{ ...creds, categories: ["expenses"], dateRange: { from: "2025-02-01", to: "2025-01-01" } }, /after the end/],
        [{ ...creds, categories: ["expenses"], dateRange: { from: "2025-13-01", to: "2025-12-01" } }, /YYYY-MM-DD/],
        [{ ...creds, categories: ["expenses"], dateRange: { from: "2025-01-01" } }, /both/],
      ];
      for (const [body, message] of cases) {
        const res = await post(ui.url, "/api/export", body);
        expect(res.status).toBe(400);
        const data = await res.json();
        expect(data.ok).toBe(false);
        expect(data.error).toMatch(message);
      }
    } finally {
      ui.stop();
    }
  });

  test("POST /api/reveal refuses folders outside the export directory", async () => {
    const out = await mkdtemp(join(tmpdir(), "ui-out-"));
    const ui = startUiServer({ port: 0, outputPath: out });
    try {
      const res = await post(ui.url, "/api/reveal", { bundleDir: tmpdir() });
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
    } finally {
      ui.stop();
    }
  });

  test("refuses requests from other sites and rebound hostnames", async () => {
    const ui = startUiServer({ port: 0 });
    try {
      const foreign = await post(ui.url, "/api/connect", { source: "brex", credentials: { apiToken: "x" } }, { origin: "https://evil.example" });
      expect(foreign.status).toBe(403);
      const rebound = await fetch(`${ui.url}/api/sources`, { headers: { host: "evil.example" } });
      expect(rebound.status).toBe(403);
      const same = await fetch(`${ui.url}/api/sources`, { headers: { origin: ui.url } });
      expect(same.status).toBe(200);
    } finally {
      ui.stop();
    }
  });

  test("falls back to the next port when the requested one is taken", () => {
    const first = startUiServer({ port: 47_801 });
    const second = startUiServer({ port: 47_801 });
    try {
      expect(second.server.port).toBe(47_802);
    } finally {
      first.stop();
      second.stop();
    }
  });
});
