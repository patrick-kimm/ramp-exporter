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
    source: { api_base: apiBase, scopes: ["users:read"] },
    export: { categories: ["users"], mode: "full", filters: {} },
    output: { backend: "local", path: outPath },
    runtime: { rate_limit_rps: 1000, max_retries: 3, log_format: "text" },
  };
}

const fastClient = (apiBase: string) =>
  new RampClient({ apiBase, credentials: creds, scopes: ["users:read"], rateLimitRps: 1000, sleepImpl: async () => {} });

describe("export users (end-to-end)", () => {
  test("produces a bundle that validate() accepts", async () => {
    const users = [
      { id: "u1", email: "a@x.com", department_id: "d1", manager_id: null },
      { id: "u2", email: "b@x.com", department_id: "d1", manager_id: "u1" },
      { id: "u3", email: "c@x.com", department_id: "d2", manager_id: "u1" },
    ];
    const mock = startMockRamp({ users, pageSize: 2 });
    const out = await mkdtemp(join(tmpdir(), "ramp-e2e-"));
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg(out, mock.url),
        credentials: creds,
        categories: ["users"],
        clientFactory: () => fastClient(mock.url),
      });

      expect(manifest.resources.users!.row_count).toBe(3);
      expect(manifest.counts_summary!.users).toBe(3);

      const lines = (await readFile(join(bundleDir, "users.jsonl"), "utf8")).trimEnd().split("\n");
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[2]!)).toEqual(users[2]!); // raw-faithful: byte-for-byte the source object

      const result = await validateBundle(bundleDir);
      expect(result.errors).toEqual([]);
      expect(result.ok).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("validate() detects tampering", async () => {
    const mock = startMockRamp({ users: [{ id: "u1" }], pageSize: 2 });
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

  test("throws for a category with no wired resources (cards in Slice 0)", async () => {
    const mock = startMockRamp({ users: [] });
    const out = await mkdtemp(join(tmpdir(), "ramp-empty-"));
    try {
      await expect(
        runExport({
          config: cfg(out, mock.url),
          credentials: creds,
          categories: ["cards"],
          clientFactory: () => fastClient(mock.url),
        }),
      ).rejects.toThrow(/No resources wired/);
    } finally {
      mock.stop();
    }
  });
});
