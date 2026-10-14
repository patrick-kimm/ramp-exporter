import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest, ResourceMeta } from "./manifest";

/** Sortable, filesystem-safe run id, e.g. 2026-06-17T12-30-00Z__a1b2c3. */
export function makeRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z"); // drop millis
  const safe = iso.replace(/:/g, "-");
  return `${safe}__${randomBytes(3).toString("hex")}`;
}

/**
 * Writes a single export bundle: {output}/{system}/{run_id}/.
 * Raw-faithful: each record is serialized verbatim as one JSONL line.
 * The _SUCCESS sentinel and the manifest are written last, via temp+rename,
 * so a half-written bundle is never mistaken for a complete one.
 */
export class BundleWriter {
  readonly runId: string;
  readonly bundleDir: string;
  private readonly resources: Record<string, ResourceMeta> = {};
  private readonly counts: Record<string, number> = {};

  constructor(outputPath: string, system = "ramp", runId: string = makeRunId()) {
    this.runId = runId;
    this.bundleDir = join(outputPath, system, runId);
  }

  async init(): Promise<void> {
    await mkdir(this.bundleDir, { recursive: true });
  }

  /** Stream records to {name}.jsonl, hashing as we go. A failed stream leaves no file behind. */
  async writeResource(name: string, records: Iterable<unknown> | AsyncIterable<unknown>): Promise<ResourceMeta> {
    const file = `${name}.jsonl`;
    const path = join(this.bundleDir, file);
    const hash = createHash("sha256");
    const handle = await open(path, "w");
    let rowCount = 0;
    try {
      for await (const record of records) {
        const line = JSON.stringify(record) + "\n";
        await handle.write(line);
        hash.update(line);
        rowCount++;
      }
    } catch (e) {
      await handle.close();
      await rm(path, { force: true });
      throw e;
    }
    await handle.close();
    const meta: ResourceMeta = {
      file,
      format: "jsonl",
      row_count: rowCount,
      sha256: hash.digest("hex"),
      status: "complete",
    };
    this.resources[name] = meta;
    this.counts[name] = rowCount;
    return meta;
  }

  /** Records a resource that produced no file, and why. */
  markResource(name: string, status: "skipped" | "failed", reason: string, scope?: string): ResourceMeta {
    const meta: ResourceMeta = { row_count: 0, status, reason, ...(scope ? { scope } : {}) };
    this.resources[name] = meta;
    this.counts[name] = 0;
    return meta;
  }

  getResources(): Record<string, ResourceMeta> {
    return { ...this.resources };
  }

  getCounts(): Record<string, number> {
    return { ...this.counts };
  }

  async writeManifest(manifest: Manifest): Promise<void> {
    await this.atomicWrite("export-metadata.json", JSON.stringify(manifest, null, 2) + "\n");
  }

  /** Sentinel written last — signals the bundle is complete and safe to ingest. */
  async writeSuccess(): Promise<void> {
    await this.atomicWrite("_SUCCESS", `${new Date().toISOString()}\n`);
  }

  /** Removes a bundle that was cancelled or failed, so it can't be mistaken for an export. */
  async discard(): Promise<void> {
    await rm(this.bundleDir, { recursive: true, force: true });
  }

  private async atomicWrite(name: string, contents: string): Promise<void> {
    const tmp = join(this.bundleDir, `.${name}.tmp`);
    await writeFile(tmp, contents);
    await rename(tmp, join(this.bundleDir, name));
  }
}
