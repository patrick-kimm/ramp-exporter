import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "../src/export";
import { validateBundle } from "../src/validate";
import { RAMP_CREDS, cfg, fastClient } from "./helpers";
import { startMockRamp } from "./mock-ramp";

describe("export cards category (end-to-end)", () => {
  test("exports cards + spend-programs + funds, raw-faithful and masked", async () => {
    // Card shape mirrors Ramp /cards (cards:read): last_four only, NO PAN.
    const cards = [
      { id: "c1", cardholder_id: "u1", last_four: "1234", state: "ACTIVE" },
      { id: "c2", cardholder_id: "u2", last_four: "5678", state: "ACTIVE" },
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

    const mock = startMockRamp({ resources: { cards, "spend-programs": programs, funds }, pageSize: 50 });
    const out = await mkdtemp(join(tmpdir(), "ramp-cards-"));
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg("ramp", out, mock.url, { categories: ["cards"] }),
        credentials: RAMP_CREDS,
        categories: ["cards"],
        clientFactory: () => fastClient("ramp", mock.url),
      });

      expect(manifest.counts_summary).toEqual({ cards: 2, "spend-programs": 1, funds: 1 });
      expect(manifest.resources["spend-programs"]!.file).toBe("spend-programs.jsonl");

      // raw-faithful + masked: the record is byte-identical, PAN never present
      const cardLines = (await readFile(join(bundleDir, "cards.jsonl"), "utf8")).trimEnd().split("\n");
      const c0 = JSON.parse(cardLines[0]!);
      expect(c0).toEqual(cards[0]!);
      expect(c0).not.toHaveProperty("card_number");
      expect(c0).not.toHaveProperty("number");

      expect((await validateBundle(bundleDir)).ok).toBe(true);
    } finally {
      mock.stop();
    }
  });
});
