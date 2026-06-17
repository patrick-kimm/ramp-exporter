#!/usr/bin/env bun
import { loadConfig, loadCredentials } from "./config";
import { runExport } from "./export";
import { validateBundle } from "./validate";
import type { Category } from "./manifest";

const VERSION = "0.1.0";
const USAGE = `ramp-exporter ${VERSION}

usage:
  ramp-exporter ui [--port 4747]                  open the local web UI
  ramp-exporter export <users|cards|vendors|all> [--config config.yml]
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
      const config = loadConfig(flags.config ?? "config.yml");
      const credentials = loadCredentials();
      const target = positionals[0] ?? "all";
      const categories: Category[] =
        target === "all" ? config.export.categories : [target as Category];
      const { bundleDir } = await runExport({
        config,
        credentials,
        categories,
        log: (m) => console.error(m),
      });
      console.log(bundleDir); // stdout = the one machine-readable result
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
        console.error(`✓ bundle OK (${n} resources)`);
      } else {
        console.error("✗ bundle invalid:");
        for (const e of result.errors) console.error(`  - ${e}`);
        process.exit(1);
      }
      break;
    }

    case "ui": {
      const { startUiServer } = await import("./ui/server");
      const port = Number(flags.port ?? "4747");
      const { url } = startUiServer({ port: Number.isFinite(port) ? port : 4747 });
      console.error(`ramp-exporter ui → ${url}`);
      console.error("Paste your Ramp credentials in the browser. Everything runs locally; nothing is stored.");
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
