import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport } from "../src/export";
import { validateBundle } from "../src/validate";
import { RAMP_CREDS, cfg, fastClient, readJsonl } from "./helpers";
import { startMockRamp } from "./mock-ramp";

describe("export vendors category (end-to-end)", () => {
  test("exports vendors + bills + transactions; date filter hits the ledger, not the master list", async () => {
    const vendors = [
      { id: "v1", business_name: "Acme", account_number_last_four: "4321" }, // bank masked at source
      { id: "v2", business_name: "Globex" },
    ];
    const bills = [{ id: "b1", vendor_id: "v1", amount: { amount: 10000, currency_code: "USD" } }];
    const transactions = [{ id: "t1", card_id: "c1", merchant_name: "Acme", amount: 2500, payment_method: "CARD" }];
    const contacts = [{ id: "ct1", email: "ap@acme.com", first_name: "AP", last_name: "Clerk", is_default: true }];
    const mock = startMockRamp({ resources: { vendors, contacts, bills, transactions }, pageSize: 50 });
    const out = await mkdtemp(join(tmpdir(), "ramp-vendors-"));
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg("ramp", out, mock.url, { categories: ["vendors"], date_range: { from: "2025-01-01", to: "2026-01-01" } }),
        credentials: RAMP_CREDS,
        categories: ["vendors"],
        clientFactory: () => fastClient("ramp", mock.url),
      });

      // The mock serves the same contact under both vendors; each link is kept.
      expect(manifest.counts_summary).toEqual({ vendors: 2, vendor_contacts: 2, bills: 1, transactions: 1 });
      expect((await validateBundle(bundleDir)).ok).toBe(true);

      // date filter applied to the ledger endpoints, normalized to ISO datetimes (Ramp rejects bare dates)...
      const txnParams = new URLSearchParams(mock.requests.find((r) => r.path.endsWith("/transactions"))!.search);
      expect(txnParams.get("from_date")).toBe("2025-01-01T00:00:00Z");
      expect(txnParams.get("to_date")).toBe("2026-01-01T23:59:59Z");
      const billParams = new URLSearchParams(mock.requests.find((r) => r.path.endsWith("/bills"))!.search);
      expect(billParams.get("from_issued_date")).toBe("2025-01-01T00:00:00Z");
      expect(billParams.get("to_issued_date")).toBe("2026-01-01T23:59:59Z");
      // ...but NOT to the vendor master list
      const vendorParams = new URLSearchParams(mock.requests.find((r) => r.path.endsWith("/vendors"))!.search);
      expect([...vendorParams.keys()]).toEqual(["page_size"]);

      // bank details arrive masked (last four only) — raw-faithful, full number never present
      const v0 = readJsonl(await readFile(join(bundleDir, "vendors.jsonl"), "utf8"))[0]!;
      expect(v0.account_number_last_four).toBe("4321");
      expect(v0).not.toHaveProperty("account_number");

      // vendor contacts: fetched per-vendor (sub-resource), tagged with vendor_id, carrying email
      const contactRows = readJsonl(await readFile(join(bundleDir, "vendor_contacts.jsonl"), "utf8"));
      expect(contactRows[0]!.email).toBe("ap@acme.com");
      expect(contactRows[0]!.vendor_id).toBe("v1");
      expect(mock.requests.filter((r) => r.path.endsWith("/contacts")).map((r) => r.path)).toEqual([
        "/developer/v1/vendors/v1/contacts",
        "/developer/v1/vendors/v2/contacts",
      ]);
    } finally {
      mock.stop();
    }
  });
});
