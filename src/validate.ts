import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Manifest } from "./manifest";

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: Manifest;
}

/**
 * Re-reads a bundle and checks it against its own manifest: _SUCCESS present,
 * every declared file exists, and each file's sha256 + row_count match.
 * The same checks the Cockpit runs on ingest — exposed here so the customer/SE
 * can self-verify before handing the bundle over.
 */
export async function validateBundle(dir: string): Promise<ValidationResult> {
  const manifestPath = join(dir, "export-metadata.json");
  if (!existsSync(manifestPath)) {
    return { ok: false, errors: ["Missing manifest: export-metadata.json"] };
  }

  let manifest: Manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  } catch (e) {
    return { ok: false, errors: [`Manifest is not valid JSON: ${(e as Error).message}`] };
  }

  const errors: string[] = [];

  if (!existsSync(join(dir, "_SUCCESS"))) {
    errors.push("Missing _SUCCESS sentinel — bundle may be incomplete.");
  }

  for (const [name, meta] of Object.entries(manifest.resources ?? {})) {
    const filePath = join(dir, meta.file);
    if (!existsSync(filePath)) {
      errors.push(`${name}: declared file missing (${meta.file})`);
      continue;
    }
    const content = await readFile(filePath);
    const sha = createHash("sha256").update(content).digest("hex");
    if (sha !== meta.sha256) {
      errors.push(
        `${name}: sha256 mismatch (manifest ${meta.sha256.slice(0, 12)}…, actual ${sha.slice(0, 12)}…)`,
      );
    }
    const rowCount = countJsonlRows(content.toString("utf8"));
    if (rowCount !== meta.row_count) {
      errors.push(`${name}: row_count mismatch (manifest ${meta.row_count}, actual ${rowCount})`);
    }
  }

  return { ok: errors.length === 0, errors, manifest };
}

function countJsonlRows(text: string): number {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed === "" ? 0 : trimmed.split("\n").filter((l) => l.length > 0).length;
}
