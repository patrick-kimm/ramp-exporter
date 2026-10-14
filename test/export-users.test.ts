import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "../src/export";
import { validateBundle } from "../src/validate";
import { RAMP_CREDS, cfg, fastClient } from "./helpers";
import { startMockRamp } from "./mock-ramp";

const config = (out: string, apiBase: string) => cfg("ramp", out, apiBase, { categories: ["users"] });

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
        config: config(out, mock.url),
        credentials: RAMP_CREDS,
        categories: ["users"],
        clientFactory: () => fastClient("ramp", mock.url),
      });

      expect(bundleDir).toBe(join(out, "ramp", manifest.run.run_id));
      expect(manifest.source.system).toBe("ramp");
      expect(manifest.run.status).toBe("complete");
      expect(manifest.resources.users!.row_count).toBe(3);
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
    });
    const out = await mkdtemp(join(tmpdir(), "ramp-tamper-"));
    try {
      const { bundleDir } = await runExport({
        config: config(out, mock.url),
        credentials: RAMP_CREDS,
        categories: ["users"],
        clientFactory: () => fastClient("ramp", mock.url),
      });

      await writeFile(join(bundleDir, "users.jsonl"), JSON.stringify({ id: "HACKED" }) + "\n");
      const result = await validateBundle(bundleDir);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes("sha256"))).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("rejects a category the source doesn't have", async () => {
    const out = await mkdtemp(join(tmpdir(), "ramp-empty-"));
    await expect(
      runExport({
        config: config(out, "http://localhost:1"),
        credentials: RAMP_CREDS,
        categories: ["invoicing"],
      }),
    ).rejects.toThrow(/Ramp has no "invoicing" category/);
  });
});
