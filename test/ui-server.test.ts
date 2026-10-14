import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer } from "../src/ui/server";
import { startMockRamp } from "./mock-ramp";

async function post(base: string, path: string, body: unknown) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

describe("ui server", () => {
  test("GET / serves the page", async () => {
    const ui = startUiServer({ port: 0 });
    try {
      const res = await fetch(`${ui.url}/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const html = await res.text();
      expect(html).toContain("Ramp");
      expect(html).toContain("/api/export");
    } finally {
      ui.stop();
    }
  });

  test("POST /api/export runs the export and returns records", async () => {
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
    const ui = startUiServer({ port: 0, apiBase: mock.url, outputPath: out });
    try {
      const res = await fetch(`${ui.url}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clientId: "id", clientSecret: "secret", categories: ["users"] }),
      });
      const data = await res.json();
      expect(data.ok).toBe(true);
      expect(data.counts.users).toBe(2);
      expect(data.resources.users[0].id).toBe("u1");
      expect(typeof data.bundleDir).toBe("string");
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/connect authenticates without exporting", async () => {
    const mock = startMockRamp();
    const ui = startUiServer({ port: 0, apiBase: mock.url });
    try {
      const data = await post(ui.url, "/api/connect", { clientId: "id", clientSecret: "secret" });
      expect(data).toEqual({ ok: true });
      expect(mock.requests.map((r) => r.path)).toEqual(["/developer/v1/token"]);
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/connect names the missing scope from Ramp's 403", async () => {
    const mock = startMockRamp({
      rejectAuthWith: { status: 403, body: '{"error":"invalid_scope","error_description":"Scope funds:read is not enabled"}' },
    });
    const ui = startUiServer({ port: 0, apiBase: mock.url });
    try {
      const data = await post(ui.url, "/api/connect", { clientId: "ramp_id_testClient123", clientSecret: "ramp_sec_testSecret456" });
      expect(data.ok).toBe(false);
      expect(data.status).toBe(403);
      expect(data.missingScopes).toEqual(["funds:read"]);
      expect(data.rampSays).toContain("invalid_scope");
      expect(data.error).not.toContain("Ramp says");
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/export streams per-resource progress when asked for NDJSON", async () => {
    const mock = startMockRamp({
      resources: {
        vendors: [{ id: "v1" }, { id: "v2" }],
        contacts: [{ id: "c1" }],
        bills: [{ id: "b1" }],
        transactions: [],
      },
      pageSize: 50,
    });
    const out = await mkdtemp(join(tmpdir(), "ui-out-"));
    const ui = startUiServer({ port: 0, apiBase: mock.url, outputPath: out });
    try {
      const res = await fetch(`${ui.url}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/x-ndjson" },
        body: JSON.stringify({ clientId: "id", clientSecret: "secret", categories: ["vendors"] }),
      });
      expect(res.headers.get("content-type")).toContain("application/x-ndjson");
      const events = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

      expect(events[0]).toEqual({ type: "plan", resources: ["vendors", "vendor_contacts", "bills", "transactions"] });
      expect(events).toContainEqual({ type: "resource_progress", resource: "vendor_contacts", done: 2, total: 2 });
      expect(events).toContainEqual({ type: "resource_done", resource: "vendor_contacts", count: 2 });
      const result = events.at(-1);
      expect(result.type).toBe("result");
      expect(result.ok).toBe(true);
      expect(result.counts).toEqual({ vendors: 2, vendor_contacts: 2, bills: 1, transactions: 0 });
    } finally {
      ui.stop();
      mock.stop();
    }
  });

  test("POST /api/reveal refuses folders outside the export directory", async () => {
    const out = await mkdtemp(join(tmpdir(), "ui-out-"));
    const ui = startUiServer({ port: 0, outputPath: out });
    try {
      const res = await fetch(`${ui.url}/api/reveal`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bundleDir: tmpdir() }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()).ok).toBe(false);
    } finally {
      ui.stop();
    }
  });

  test("POST /api/export returns a friendly error when creds are missing", async () => {
    const ui = startUiServer({ port: 0 });
    try {
      const res = await fetch(`${ui.url}/api/export`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ categories: ["users"] }),
      });
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error).toContain("required");
    } finally {
      ui.stop();
    }
  });
});
