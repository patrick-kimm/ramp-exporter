#!/usr/bin/env bun
import { loadConfig, loadCredentials } from "./config";
import { runExport } from "./export";
import { SOURCES, SOURCE_IDS, isSourceId } from "./sources";
import { startUiServer } from "./ui/server";
import { validateBundle } from "./validate";

const VERSION = "0.2.0";
const USAGE = `ramp-exporter ${VERSION} — export your data from ${SOURCE_IDS.map((id) => SOURCES[id].label).join(", ")}

usage:
  ramp-exporter ui [--port 4747]                       open the local web UI
  ramp-exporter export [<category>...|all] [--source ramp|mercury|brex|rho] [--config config.yml]
  ramp-exporter sources                                 list sources, their categories, and env vars
  ramp-exporter validate <bundle-dir>
  ramp-exporter version
`;

interface Parsed {
  positionals: string[];
  flags: Record<string, string>;
}

function parseArgs(args: string[]): Parsed {
  const positionals: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = args[i + 1];
        if (next !== undefined && !next.startsWith("--")) {
          flags[a.slice(2)] = next;
          i++;
        } else {
          flags[a.slice(2)] = "true";
        }
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positionals, flags } = parseArgs(rest);

  switch (cmd) {
    case "export": {
      const config = loadConfig(flags.config ?? "config.yml", { required: flags.config !== undefined });
      if (flags.source !== undefined) {
        if (!isSourceId(flags.source)) {
          console.error(`unknown source: ${flags.source} (choose from ${SOURCE_IDS.join(", ")})`);
          process.exit(2);
        }
        if (flags.source !== config.source.system) {
          // These settings in config.yml were written for the other source; the date range still applies.
          config.source = { system: flags.source };
          config.export.categories = undefined;
          config.runtime.rate_limit_rps = undefined;
        }
      }
      const source = SOURCES[config.source.system];
      const credentials = loadCredentials(source);
      const all = positionals.length === 0 || positionals.includes("all");
      const { bundleDir, manifest } = await runExport({
        config,
        credentials,
        categories: all ? undefined : positionals,
        log: (m) => console.error(m),
      });
      if (manifest.run.status === "partial") {
        const skipped = Object.entries(manifest.resources).filter(([, m]) => m.status !== "complete");
        console.error(`\n⚠ partial export — ${skipped.length} resource(s) not exported:`);
        for (const [name, m] of skipped) console.error(`  - ${name}: ${m.reason}`);
      }
      console.log(bundleDir); // stdout = the one machine-readable result
      break;
    }

    case "sources": {
      for (const id of SOURCE_IDS) {
        const s = SOURCES[id];
        console.log(`${id} — ${s.label}: ${s.tagline}`);
        console.log(`  env: ${s.credentials.map((c) => c.env).join(", ")}`);
        for (const c of s.categories) console.log(`  ${c.id.padEnd(10)} ${c.resources.join(", ")}`);
        console.log("");
      }
      break;
    }

    case "validate": {
      const dir = positionals[0];
      if (!dir) {
        console.error("usage: ramp-exporter validate <bundle-dir>");
        process.exit(2);
      }
      const result = await validateBundle(dir);
      if (result.ok) {
        const n = Object.keys(result.manifest?.resources ?? {}).length;
        const status = result.manifest?.run.status;
        console.error(`✓ bundle OK (${n} resources${status && status !== "complete" ? `, run ${status}` : ""})`);
      } else {
        console.error("✗ bundle invalid:");
        for (const e of result.errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      break;
    }

    case "ui": {
      const port = Number(flags.port ?? "4747");
      const { url } = startUiServer({ port: Number.isFinite(port) ? port : 4747 });
      console.error(`ramp-exporter ui → ${url}`);
      console.error("Paste your credentials in the browser. Everything runs locally; nothing is stored.");
      try {
        const opener =
          process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        Bun.spawn([opener, url]);
      } catch {
        // browser auto-open is best-effort
      }
      await new Promise(() => {}); // keep the server alive until Ctrl-C
      break;
    }

    case "version":
    case "--version":
    case "-v":
      console.log(VERSION);
      break;

    case undefined:
      console.error(USAGE);
      break;

    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
