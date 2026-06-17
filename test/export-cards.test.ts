import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config";
import { runExport } from "../src/export";
import { RampClient } from "../src/ramp/client";
import { validateBundle } from "../src/validate";
import { startMockRamp } from "./mock-ramp";

const creds = { clientId: "id", clientSecret: "secret" };
const fastClient = (apiBase: string) =>
  new RampClient({ apiBase, credentials: creds, rateLimitRps: 1000, sleepImpl: async () => {} });

function cfg(out: string, apiBase: string): Config {
  return {
    format_version: "1.0",
    source: { api_base: apiBase, scopes: ["cards:read", "limits:read", "spend_programs:read", "funds:read"] },
    export: { categories: ["cards"], mode: "full", filters: {} },
    output: { backend: "local", path: out },
    runtime: { rate_limit_rps: 1000, max_retries: 3, log_format: "text" },
  };
}

describe("export cards category (end-to-end)", () => {
  test("exports cards + limits + spend-programs, raw-faithful and masked", async () => {
    // Card shape mirrors Ramp /cards (cards:read): last_four only, NO PAN.
    const cards = [
      { id: "c1", cardholder_id: "u1", last_four: "1234", state: "ACTIVE" },
      { id: "c2", cardholder_id: "u2", last_four: "5678", state: "ACTIVE" },
    ];
    const limits = [
      {
        id: "sl1",
        display_name: "Travel",
        restrictions: { amount: { amount: 50000, currency_code: "USD" }, interval: "MONTHLY" },
        spend_program_id: "sp1",
      },
    ];
    const programs = [{ id: "sp1", display_name: "T&E" }];
    // A Fund = virtual-account bucket; its cards[] is how a card's bucket is discovered.
    const funds = [
      {
        id: "f1",
        display_name: "Marketing",
        balance: { total: { amount: 100000, currency_code: "USD" } },
        cards: [{ card_id: "c1" }],
        members: [{ user_id: "u1" }],
      },
    ];

    const mock = startMockRamp({
      resources: { cards, limits, "spend-programs": programs, funds },
      pageSize: 50,
    });
    const out = await mkdtemp(join(tmpdir(), "ramp-cards-"));
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg(out, mock.url),
        credentials: creds,
        categories: ["cards"],
        clientFactory: () => fastClient(mock.url),
      });

      expect(manifest.counts_summary).toEqual({ cards: 2, limits: 1, "spend-programs": 1, funds: 1 });
      expect(manifest.resources["spend-programs"]!.file).toBe("spend-programs.jsonl");

      // raw-faithful + masked: the record is byte-identical, PAN never present
      const cardLines = (await readFile(join(bundleDir, "cards.jsonl"), "utf8")).trimEnd().split("\n");
      const c0 = JSON.parse(cardLines[0]!);
      expect(c0).toEqual(cards[0]!);
      expect(c0).not.toHaveProperty("card_number");
      expect(c0).not.toHaveProperty("number");

      const result = await validateBundle(bundleDir);
      expect(result.ok).toBe(true);
    } finally {
      mock.stop();
    }
  });
});
