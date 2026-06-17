import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { runExport } from "../src/export";
import { RampClient } from "../src/ramp/client";
import { validateBundle } from "../src/validate";
import { startMockRamp } from "./mock-ramp";

const creds = { clientId: "id", clientSecret: "secret" };

function cfg(outPath: string, apiBase: string): Config {
  return {
    format_version: "1.0",
    source: {
      api_base: apiBase,
      scopes: ["users:read", "departments:read", "locations:read", "entities:read"],
    },
    export: { categories: ["users"], mode: "full", filters: {} },
    output: { backend: "local", path: outPath },
    runtime: { rate_limit_rps: 1000, max_retries: 3, log_format: "text" },
  };
}

const fastClient = (apiBase: string) =>
  new RampClient({ apiBase, credentials: creds, rateLimitRps: 1000, sleepImpl: async () => {} });

describe("export users category (end-to-end)", () => {
  test("exports users + departments + locations into a bundle validate() accepts", async () => {
    const users = [
      { id: "u1", email: "a@x.com", department_id: "d1", manager_id: null },
      { id: "u2", email: "b@x.com", department_id: "d1", manager_id: "u1" },
      { id: "u3", email: "c@x.com", department_id: "d2", manager_id: "u1" },
    ];
    const departments = [{ id: "d1", name: "Engineering" }, { id: "d2", name: "Ops" }];
    const locations = [{ id: "l1", name: "NYC" }];
    const entities = [{ id: "e1", entity_name: "HQ", is_primary: true }];
    const mock = startMockRamp({ resources: { users, departments, locations, entities }, pageSize: 2 });
    const out = await mkdtemp(join(tmpdir(), "ramp-e2e-"));
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg(out, mock.url),
        credentials: creds,
        categories: ["users"],
        clientFactory: () => fastClient(mock.url),
      });

      expect(manifest.resources.users!.row_count).toBe(3);
      expect(manifest.resources.departments!.row_count).toBe(2);
      expect(manifest.resources.locations!.row_count).toBe(1);
      expect(manifest.counts_summary).toEqual({ users: 3, departments: 2, locations: 1, entities: 1 });

      // raw-faithful: a record is written byte-for-byte as the source object
      const lines = (await readFile(join(bundleDir, "users.jsonl"), "utf8")).trimEnd().split("\n");
      expect(JSON.parse(lines[2]!)).toEqual(users[2]!);

      const result = await validateBundle(bundleDir);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("validate() detects tampering", async () => {
    const mock = startMockRamp({
      resources: { users: [{ id: "u1" }], departments: [], locations: [], entities: [] },
      pageSize: 2,
    });
    const out = await mkdtemp(join(tmpdir(), "ramp-tamper-"));
    try {
      const { bundleDir } = await runExport({
        config: cfg(out, mock.url),
        credentials: creds,
        categories: ["users"],
        clientFactory: () => fastClient(mock.url),
      });

      await writeFile(join(bundleDir, "users.jsonl"), JSON.stringify({ id: "HACKED" }) + "\n");
      const result = await validateBundle(bundleDir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("sha256"))).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("throws when a category maps to no resources", async () => {
    const mock = startMockRamp({ resources: {} });
    const out = await mkdtemp(join(tmpdir(), "ramp-empty-"));
    try {
      await expect(
        runExport({
          config: cfg(out, mock.url),
          credentials: creds,
          categories: ["nonexistent" as never], // exercises the guard directly
          clientFactory: () => fastClient(mock.url),
        }),
      ).rejects.toThrow(/No resources wired/);
    } finally {
      mock.stop();
    }
  });
});
