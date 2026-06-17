import { createHash, randomBytes } from "node:crypto";
import { open, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Manifest, ResourceMeta } from "./manifest";

/** Sortable, filesystem-safe run id, e.g. 2026-06-17T12-30-00Z__a1b2c3. */
export function makeRunId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/\.\d{3}Z$/, "Z"); // drop millis
  const safe = iso.replace(/:/g, "-");
  return `${safe}__${randomBytes(3).toString("hex")}`;
}

/**
 * Writes a single export bundle: {output}/ramp/{run_id}/.
 * Raw-faithful: each record is serialized verbatim as one JSONL line.
 * The _SUCCESS sentinel and the manifest are written last, via temp+rename,
 * so a half-written bundle is never mistaken for a complete one.
 */
export class BundleWriter {
  readonly runId: string;
  readonly bundleDir: string;
  private readonly resources: Record<string, ResourceMeta> = {};
  private readonly counts: Record<string, number> = {};

  constructor(outputPath: string, runId: string = makeRunId()) {
    this.runId = runId;
    this.bundleDir = join(outputPath, "ramp", runId);
  }

  async init(): Promise<void> {
    await mkdir(this.bundleDir, { recursive: true });
  }

  /** Stream records to {name}.jsonl, hashing as we go. */
  async writeResource(name: string, records: Iterable<unknown>): Promise<ResourceMeta> {
    const file = `${name}.jsonl`;
    const hash = createHash("sha256");
    const handle = await open(join(this.bundleDir, file), "w");
    let rowCount = 0;
    try {
      for (const record of records) {
        const line = JSON.stringify(record) + "\n";
        await handle.write(line);
        hash.update(line);
        rowCount++;
      }
    } finally {
      await handle.close();
    }
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

  private async atomicWrite(name: string, contents: string): Promise<void> {
    const tmp = join(this.bundleDir, `.${name}.tmp`);
    await writeFile(tmp, contents);
    await rename(tmp, join(this.bundleDir, name));
  }
}
