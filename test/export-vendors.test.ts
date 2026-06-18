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
    source: { api_base: apiBase, scopes: ["vendors:read", "bills:read", "transactions:read"] },
    export: {
      categories: ["vendors"],
      mode: "full",
      filters: { date_range: { from: "2025-01-01", to: "2026-01-01" } },
    },
    output: { backend: "local", path: out },
    runtime: { rate_limit_rps: 1000, max_retries: 3, log_format: "text" },
  };
}

describe("export vendors category (end-to-end)", () => {
  test("exports vendors + bills + transactions; date filter hits the ledger, not the master list", async () => {
    const vendors = [
      { id: "v1", business_name: "Acme", account_number_last_four: "4321" }, // bank masked at source
      { id: "v2", business_name: "Globex" },
    ];
    const bills = [{ id: "b1", vendor_id: "v1", amount: { amount: 10000, currency_code: "USD" } }];
    const transactions = [
      { id: "t1", card_id: "c1", merchant_name: "Acme", amount: 2500, payment_method: "CARD" },
    ];
    const contacts = [{ id: "ct1", email: "ap@acme.com", first_name: "AP", last_name: "Clerk", is_default: true }];
    const mock = startMockRamp({ resources: { vendors, contacts, bills, transactions }, pageSize: 50 });
    const out = await mkdtemp(join(tmpdir(), "ramp-vendors-"));
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg(out, mock.url),
        credentials: creds,
        categories: ["vendors"],
        clientFactory: () => fastClient(mock.url),
      });

      expect(manifest.counts_summary).toEqual({ vendors: 2, vendor_contacts: 2, bills: 1, transactions: 1 });
      expect(await validateBundle(bundleDir).then((r) => r.ok)).toBe(true);

      // date filter applied to the ledger endpoints, normalized to ISO datetimes (Ramp rejects bare dates)...
      const txnParams = new URLSearchParams(mock.requests.find((r) => r.path.endsWith("/transactions"))!.search);
      expect(txnParams.get("from_date")).toBe("2025-01-01T00:00:00Z");
      expect(txnParams.get("to_date")).toBe("2026-01-01T23:59:59Z");
      const billParams = new URLSearchParams(mock.requests.find((r) => r.path.endsWith("/bills"))!.search);
      expect(billParams.get("from_issued_date")).toBe("2025-01-01T00:00:00Z");
      expect(billParams.get("to_issued_date")).toBe("2026-01-01T23:59:59Z");
      // ...but NOT to the vendor master list
      expect(mock.requests.find((r) => r.path.endsWith("/vendors"))!.search).toBe("");

      // bank details arrive masked (last four only) — raw-faithful, full number never present
      const v0 = JSON.parse(
        (await readFile(join(bundleDir, "vendors.jsonl"), "utf8")).trimEnd().split("\n")[0]!,
      );
      expect(v0.account_number_last_four).toBe("4321");
      expect(v0).not.toHaveProperty("account_number");

      // vendor contacts: fetched per-vendor (sub-resource), tagged with vendor_id, carrying email
      const contactRows = (await readFile(join(bundleDir, "vendor_contacts.jsonl"), "utf8"))
        .trimEnd().split("\n").map((l) => JSON.parse(l));
      expect(contactRows).toHaveLength(2); // one per vendor
      expect(contactRows[0].email).toBe("ap@acme.com");
      expect(["v1", "v2"]).toContain(contactRows[0].vendor_id);
    } finally {
      mock.stop();
    }
  });
});
