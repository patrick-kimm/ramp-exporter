import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BundleWriter, makeRunId } from "../src/bundle";
import { buildManifest } from "../src/manifest";

const tmp = () => mkdtemp(join(tmpdir(), "ramp-bundle-"));

describe("BundleWriter", () => {
  test("writes JSONL with correct rows + matching sha256", async () => {
    const w = new BundleWriter(await tmp(), "ramp", "RUNID");
    await w.init();
    const records = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const meta = await w.writeResource("users", records);

    expect(meta.row_count).toBe(3);
    expect(meta.format).toBe("jsonl");
    expect(meta.status).toBe("complete");

    const content = await readFile(join(w.bundleDir, "users.jsonl"));
    const lines = content.toString("utf8").trimEnd().split("\n");
    expect(lines.length).toBe(3);
    expect(JSON.parse(lines[0]!)).toEqual({ id: "a" });
    expect(createHash("sha256").update(content).digest("hex")).toBe(meta.sha256!);
  });

  test("writes manifest + _SUCCESS last", async () => {
    const w = new BundleWriter(await tmp(), "ramp", "RUNID");
    await w.init();
    await w.writeResource("users", [{ id: "a" }]);
    const manifest = buildManifest({
      exporterVersion: "0.1.0",
      system: "ramp",
      runId: "RUNID",
      startedAt: "t0",
      completedAt: "t1",
      mode: "full",
      categories: ["users"],
      resources: w.getResources(),
      counts: w.getCounts(),
    });
    await w.writeManifest(manifest);
    await w.writeSuccess();

    const entries = await readdir(w.bundleDir);
    expect(entries.sort()).toEqual(["_SUCCESS", "export-metadata.json", "users.jsonl"]);
    // no leftover temp files
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);

    const written = JSON.parse(await readFile(join(w.bundleDir, "export-metadata.json"), "utf8"));
    expect(written.resources.users.row_count).toBe(1);
    expect(written.counts_summary.users).toBe(1);
    expect(written.source.system).toBe("ramp");
    expect(written.run.mode).toBe("full");
  });

  test("writes into {output}/{system}/{run_id}", async () => {
    const out = await tmp();
    const w = new BundleWriter(out, "mercury", "RUNID");
    expect(w.bundleDir).toBe(join(out, "mercury", "RUNID"));
  });

  test("a failed stream leaves no partial file behind", async () => {
    const w = new BundleWriter(await tmp(), "ramp", "RUNID");
    await w.init();
    async function* boom() {
      yield { id: "a" };
      throw new Error("connection reset");
    }
    await expect(w.writeResource("users", boom())).rejects.toThrow("connection reset");
    expect(await readdir(w.bundleDir)).toEqual([]);
  });

  test("skipped resources have no file, and make the run partial", async () => {
    const w = new BundleWriter(await tmp(), "brex", "RUNID");
    await w.init();
    await w.writeResource("users", [{ id: "a" }]);
    w.markResource("cards", "skipped", "Brex denied access.", "cards.readonly");
    const manifest = buildManifest({
      exporterVersion: "0.2.0",
      system: "brex",
      runId: "RUNID",
      startedAt: "t0",
      completedAt: "t1",
      mode: "full",
      resources: w.getResources(),
      counts: w.getCounts(),
    });
    expect(manifest.run.status).toBe("partial");
    expect(manifest.resources.cards).toEqual({ row_count: 0, status: "skipped", reason: "Brex denied access.", scope: "cards.readonly" });
  });

  test("discard() removes the bundle", async () => {
    const out = await tmp();
    const w = new BundleWriter(out, "rho", "RUNID");
    await w.init();
    await w.writeResource("users", [{ id: "a" }]);
    await w.discard();
    expect(await readdir(join(out, "rho"))).toEqual([]);
  });

  test("makeRunId is sortable and filesystem-safe", () => {
    const id = makeRunId(new Date("2026-06-17T12:30:00.000Z"));
    expect(id).toMatch(/^2026-06-17T12-30-00Z__[0-9a-f]{6}$/);
  });
});
