import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer } from "../src/ui/server";
import { startMockRamp } from "./mock-ramp";

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
