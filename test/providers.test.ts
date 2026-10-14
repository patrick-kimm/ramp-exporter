import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadCredentials } from "../src/config";
import { runExport } from "../src/export";
import { cleanToken, SourceError } from "../src/sources/client";
import { checkAccess, dateRangeProblem, formatBound } from "../src/sources/fetch";
import { getSource, resourcesForCategories, SOURCES } from "../src/sources";
import { SOURCE_IDS, scopesFor } from "../src/sources/types";
import { validateBundle } from "../src/validate";
import { cfg, credsFor, fastClient, readJsonl } from "./helpers";
import { startMockSource } from "./mock-source";

const tmp = (p: string) => mkdtemp(join(tmpdir(), `${p}-`));
const paramsOf = (mock: { requests: { path: string; search: string }[] }, suffix: string) =>
  new URLSearchParams(mock.requests.find((r) => r.path.endsWith(suffix))!.search);

describe("source definitions", () => {
  test.each([...SOURCE_IDS])("%s: every category resource exists and every child's parent is exported first", (id) => {
    const s = getSource(id);
    for (const c of s.categories) {
      for (const name of c.resources) expect(s.resources[name]).toBeDefined();
    }
    const order = Object.keys(s.resources);
    for (const [name, def] of Object.entries(s.resources)) {
      if (!def.parent) {
        expect(def.path).toBeDefined();
        continue;
      }
      expect(order.indexOf(def.parent.resource)).toBeLessThan(order.indexOf(name));
      // a child is useless without its parent in the same category
      const cat = s.categories.find((c) => c.resources.includes(name))!;
      expect(cat.resources).toContain(def.parent.resource);
    }
    expect(s.credentials.every((f) => f.env.startsWith(id.toUpperCase()))).toBe(true);
  });

  test("resourcesForCategories keeps source order and de-duplicates", () => {
    expect(resourcesForCategories(SOURCES.ramp, ["vendors", "users", "vendors"])).toEqual([
      "users",
      "departments",
      "locations",
      "entities",
      "vendors",
      "vendor_contacts",
      "bills",
      "transactions",
    ]);
  });

  test("scopesFor lists Ramp's 10 scopes", () => {
    expect(scopesFor(SOURCES.ramp)).toHaveLength(10);
    expect(scopesFor(SOURCES.mercury)).toEqual([]);
  });
});

describe("date bounds", () => {
  test("each format renders an inclusive day range correctly", () => {
    expect(formatBound("2025-01-31", "to", "date")).toBe("2025-01-31");
    expect(formatBound("2025-01-31", "to", "date_exclusive")).toBe("2025-02-01");
    expect(formatBound("2024-12-31", "to", "date_exclusive")).toBe("2025-01-01");
    expect(formatBound("2024-02-28", "to", "date_exclusive")).toBe("2024-02-29"); // leap year
    expect(formatBound("2025-01-01", "from", "datetime")).toBe("2025-01-01T00:00:00Z");
    expect(formatBound("2025-01-31", "to", "datetime")).toBe("2025-01-31T23:59:59Z");
    expect(formatBound("2025-01-31", "to", "datetime_exclusive")).toBe("2025-02-01T00:00:00Z");
    expect(formatBound("2025-01-01T12:00:00Z", "to", "datetime")).toBe("2025-01-01T12:00:00Z");
  });
});

describe("date range validation", () => {
  test.each([
    [{ from: "2025-01-01", to: "2025-01-31" }, undefined],
    [{ from: "2025-01-31", to: "2025-01-01" }, /after the end/],
    [{ from: "2025-02-30", to: "2025-03-01" }, /YYYY-MM-DD/],
    [{ from: "2025-1-1", to: "2025-03-01" }, /YYYY-MM-DD/],
    [{ from: "2025-01-01" }, /both/],
  ])("%j", (range, problem) => {
    const got = dateRangeProblem(range);
    if (problem) expect(got).toMatch(problem);
    else expect(got).toBeUndefined();
  });

  test("a bad range in config fails before any request", async () => {
    const mock = startMockSource({ style: "rho", routes: { "/transactions": [] } });
    try {
      await expect(
        runExport({
          config: cfg("rho", await tmp("rho-badrange"), mock.url, { categories: ["accounts"], date_range: { from: "2025-06-01", to: "2025-01-01" } }),
          credentials: credsFor("rho"),
          clientFactory: () => fastClient("rho", mock.url),
        }),
      ).rejects.toThrow(/date_range/);
      expect(mock.requests).toEqual([]);
    } finally {
      mock.stop();
    }
  });
});

describe("tokens", () => {
  test("cleanToken strips quotes, whitespace, and a Bearer prefix", () => {
    expect(cleanToken('  "bxt_abc"\n')).toBe("bxt_abc");
    expect(cleanToken("Bearer bxt_abc")).toBe("bxt_abc");
    expect(cleanToken("'secret-token:mercury_x'")).toBe("secret-token:mercury_x");
  });

  test("Mercury gets its secret-token: prefix whether or not it was pasted", async () => {
    const mock = startMockSource({ style: "mercury", token: "secret-token:abc", routes: { "/cards": [] } });
    try {
      for (const pasted of ["abc", "secret-token:abc", ' "Bearer secret-token:abc" ']) {
        const out: unknown[] = [];
        for await (const r of fastClient("mercury", mock.url, { apiToken: pasted }).paginate(SOURCES.mercury.resources.cards!, "/cards")) out.push(r);
        expect(out).toEqual([]);
      }
      expect(new Set(mock.requests.map((r) => r.auth))).toEqual(new Set(["Bearer secret-token:abc"]));
    } finally {
      mock.stop();
    }
  });

  test("a wrong bearer token fails the run as an auth error, with the token redacted", async () => {
    const mock = startMockSource({ style: "brex", routes: { "/v2/company": { object: { id: "co" } } } });
    const out = await tmp("brex-auth");
    try {
      const err = (await runExport({
        config: cfg("brex", out, mock.url, { categories: ["users"] }),
        credentials: { apiToken: "bxt_wrong" },
        clientFactory: () => fastClient("brex", mock.url, { apiToken: "bxt_wrong" }),
      }).catch((e: unknown) => e)) as SourceError;
      expect(err).toBeInstanceOf(SourceError);
      expect(err.kind).toBe("auth");
      expect(err.message).not.toContain("bxt_wrong");
      // nothing left behind
      expect(await readdir(join(out, "brex")).catch(() => [])).toEqual([]);
    } finally {
      mock.stop();
    }
  });
});

describe("Mercury export (end-to-end)", () => {
  test("every category: start_after paging, per-account statements, dates as plain days", async () => {
    const accounts = [{ id: "a1", accountNumber: "1234567890" }, { id: "a2" }, { id: "a3" }];
    const mock = startMockSource({
      style: "mercury",
      token: "secret-token:test-api-token",
      routes: {
        "/organization": { object: { id: "org", legalBusinessName: "Acme Inc" }, key: "organization" },
        "/users": [{ userId: "u1" }, { userId: "u2" }, { userId: "u3" }],
        "/accounts": accounts,
        "/credit": { list: [{ id: "cr1" }], key: "accounts", unpaged: true },
        "/treasury": { list: [{ id: "t1" }], key: "accounts" },
        "/account/a1/statements": [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
        "/account/a2/statements": [{ id: "s4" }],
        // a3 was closed: Mercury 404s, which shouldn't sink the other accounts
        "/transactions": [{ id: "x1" }, { id: "x2" }, { id: "x3" }, { id: "x4" }, { id: "x5" }],
        "/categories": [],
        "/cards": [{ id: "c1" }],
        "/recipients": [{ id: "r1" }],
        "/ar/customers": [{ id: "cu1" }],
        "/ar/invoices": [{ id: "i1" }, { id: "i2" }],
      },
    });
    const out = await tmp("mercury");
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg("mercury", out, mock.url, { date_range: { from: "2025-01-01", to: "2025-12-31" } }),
        credentials: { apiToken: "test-api-token" },
        clientFactory: () => fastClient("mercury", mock.url),
      });

      expect(manifest.source.system).toBe("mercury");
      expect(manifest.run.status).toBe("complete");
      expect(manifest.counts_summary).toEqual({
        organization: 1,
        users: 3,
        accounts: 3,
        credit_accounts: 1,
        treasury_accounts: 1,
        statements: 4,
        transactions: 5,
        categories: 0,
        cards: 1,
        recipients: 1,
        customers: 1,
        invoices: 2,
      });
      expect((await validateBundle(bundleDir)).ok).toBe(true);

      const tx = paramsOf(mock, "/transactions");
      expect(tx.get("start")).toBe("2025-01-01");
      expect(tx.get("end")).toBe("2025-12-31");
      expect(tx.get("limit")).toBe("1000");
      expect(mock.requests.filter((r) => r.path.endsWith("/transactions")).map((r) => new URLSearchParams(r.search).get("start_after"))).toEqual([
        null,
        "after:2",
        "after:4",
      ]);

      const statements = readJsonl(await readFile(join(bundleDir, "statements.jsonl"), "utf8"));
      expect(statements.map((s) => [s.accountId, s.id])).toEqual([
        ["a1", "s1"],
        ["a1", "s2"],
        ["a1", "s3"],
        ["a2", "s4"],
      ]);
      // full bank numbers are exported verbatim (the UI warns); nothing is altered
      expect(readJsonl(await readFile(join(bundleDir, "accounts.jsonl"), "utf8"))[0]).toEqual(accounts[0]!);
    } finally {
      mock.stop();
    }
  });
});

describe("Brex export (end-to-end)", () => {
  test("cursor paging, bare-array accounts, cash children, and a local end bound", async () => {
    const mock = startMockSource({
      style: "brex",
      routes: {
        "/v2/accounts/card": { array: [{ id: "ca1" }] },
        "/v2/accounts/card/primary/statements": [{ id: "cs1" }],
        "/v2/transactions/card/primary": [
          { id: "t1", posted_at_date: "2025-03-01" },
          { id: "t2", posted_at_date: "2025-03-31" },
          { id: "t3", posted_at_date: "2025-04-01" },
        ],
        "/v2/accounts/cash": [{ id: "cash1" }],
        "/v2/accounts/cash/cash1/statements": [{ id: "st1" }],
        "/v2/transactions/cash/cash1": [
          { id: "ct1", posted_at_date: "2025-03-15" },
          { id: "ct2", posted_at_date: "2025-05-01" },
        ],
        "/v1/linked_accounts": [],
      },
    });
    const out = await tmp("brex");
    try {
      const { bundleDir, manifest } = await runExport({
        config: cfg("brex", out, mock.url, { categories: ["accounts"], date_range: { from: "2025-03-01", to: "2025-03-31" } }),
        credentials: credsFor("brex"),
        clientFactory: () => fastClient("brex", mock.url),
      });
      expect(manifest.counts_summary).toEqual({
        card_accounts: 1,
        card_statements: 1,
        card_transactions: 2,
        cash_accounts: 1,
        cash_statements: 1,
        cash_transactions: 1,
        linked_accounts: 0,
      });
      expect(paramsOf(mock, "/v2/transactions/card/primary").get("posted_at_start")).toBe("2025-03-01T00:00:00Z");
      const cash = readJsonl(await readFile(join(bundleDir, "cash_transactions.jsonl"), "utf8"));
      expect(cash).toEqual([{ cash_account_id: "cash1", id: "ct1", posted_at_date: "2025-03-15" }]);
      expect(mock.requests.every((r) => r.auth === "Bearer test-api-token")).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("expenses send expand[] and both purchased_at bounds; budgets dedupe by budget_id", async () => {
    const mock = startMockSource({
      style: "brex",
      pageSize: 1,
      routes: {
        "/v1/expenses": [{ id: "e1" }, { id: "e2" }],
        "/v2/cards": [{ id: "c1" }],
        // the same budget repeated across a page boundary is kept once
        "/v2/budgets": [{ budget_id: "b1" }, { budget_id: "b1" }, { budget_id: "b2" }],
        "/v2/spend_limits": [],
        "/v1/budget_programs": [],
      },
    });
    const out = await tmp("brex-exp");
    try {
      const { manifest } = await runExport({
        config: cfg("brex", out, mock.url, { categories: ["cards", "expenses"], date_range: { from: "2025-01-01", to: "2025-01-31" } }),
        credentials: credsFor("brex"),
        clientFactory: () => fastClient("brex", mock.url),
      });
      expect(manifest.counts_summary).toMatchObject({ expenses: 2, budgets: 2 });
      const p = paramsOf(mock, "/v1/expenses");
      expect(p.getAll("expand[]")).toEqual(["merchant", "user", "budget"]);
      expect(p.get("purchased_at_start")).toBe("2025-01-01T00:00:00Z");
      expect(p.get("purchased_at_end")).toBe("2025-01-31T23:59:59Z");
      expect(p.get("load_custom_fields")).toBe("true");
    } finally {
      mock.stop();
    }
  });

  test("a resource the token can't read is skipped; the rest still export (partial run)", async () => {
    const mock = startMockSource({
      style: "brex",
      routes: {
        "/v2/company": { object: { id: "co", legal_name: "Acme" } },
        "/v2/users": [{ id: "u1" }],
        "/v2/departments": { status: 403, body: '{"message":"Missing scope departments.readonly"}' },
        "/v2/locations": [],
        "/v2/titles": [],
        // Brex returns 404 for features the account doesn't have
        "/v2/cost_centers": { status: 404 },
        "/v2/legal_entities": { status: 500, body: "boom" },
      },
    });
    const out = await tmp("brex-partial");
    try {
      const events: string[] = [];
      const { bundleDir, manifest } = await runExport({
        config: cfg("brex", out, mock.url, { categories: ["users"] }),
        credentials: credsFor("brex"),
        clientFactory: () => fastClient("brex", mock.url),
        onProgress: (e) => {
          if (e.type === "resource_skipped") events.push(`${e.resource}:${e.status}`);
        },
      });
      expect(manifest.run.status).toBe("partial");
      expect(manifest.resources.departments).toMatchObject({ status: "skipped", scope: "departments.readonly", row_count: 0 });
      expect(manifest.resources.departments!.file).toBeUndefined();
      expect(manifest.resources.cost_centers!.status).toBe("skipped");
      expect(manifest.resources.legal_entities!.status).toBe("failed");
      expect(manifest.resources.legal_entities!.reason).toContain("server error");
      expect(events).toEqual(["departments:skipped", "cost_centers:skipped", "legal_entities:failed"]);

      const files = await readdir(bundleDir);
      expect(files).not.toContain("departments.jsonl");
      expect(files).toContain("_SUCCESS");
      expect((await validateBundle(bundleDir)).ok).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("children of a skipped parent are skipped too", async () => {
    const mock = startMockSource({
      style: "brex",
      routes: {
        "/v2/accounts/card": { array: [] },
        "/v2/accounts/card/primary/statements": [],
        "/v2/transactions/card/primary": [],
        "/v2/accounts/cash": { status: 403 },
        "/v1/linked_accounts": [],
      },
    });
    const out = await tmp("brex-child");
    try {
      const { manifest } = await runExport({
        config: cfg("brex", out, mock.url, { categories: ["accounts"] }),
        credentials: credsFor("brex"),
        clientFactory: () => fastClient("brex", mock.url),
      });
      expect(manifest.resources.cash_statements).toMatchObject({ status: "skipped", reason: "Needs cash accounts, which couldn't be exported." });
      expect(manifest.resources.cash_transactions!.status).toBe("skipped");
      expect(mock.requests.some((r) => r.path.includes("/cash/"))).toBe(false);
    } finally {
      mock.stop();
    }
  });

  test("when nothing at all can be exported, the run fails and leaves no bundle", async () => {
    const mock = startMockSource({ style: "brex", routes: { "/v1/expenses": { status: 403 } } });
    const out = await tmp("brex-none");
    try {
      await expect(
        runExport({
          config: cfg("brex", out, mock.url, { categories: ["expenses"] }),
          credentials: credsFor("brex"),
          clientFactory: () => fastClient("brex", mock.url),
        }),
      ).rejects.toThrow(/Nothing could be exported from Brex/);
      expect(await readdir(join(out, "brex"))).toEqual([]);
    } finally {
      mock.stop();
    }
  });
});

describe("Rho export (end-to-end)", () => {
  test("page_token paging, removed users, and exclusive end dates", async () => {
    const mock = startMockSource({
      style: "rho",
      routes: {
        "/business": { object: { id: "b", legal_name: "Acme LLC" } },
        "/users": [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
        "/users?membership_status=removed": [{ id: "u0", membership_status: "removed" }],
        "/expenses": [{ id: "e1" }],
        "/reimbursements": [],
        "/fields": [{ id: "f1" }],
        "/transactions": [{ id: "t1" }, { id: "t2" }, { id: "t3" }],
        "/accounts": [{ id: "a1" }],
        "/credit-programs": { list: [], key: "credit_programs", unpaged: true },
        "/statements": [],
      },
    });
    const out = await tmp("rho");
    try {
      const { manifest } = await runExport({
        config: cfg("rho", out, mock.url, { categories: ["users", "accounts", "expenses"], date_range: { from: "2025-01-01", to: "2025-01-31" } }),
        credentials: credsFor("rho"),
        clientFactory: () => fastClient("rho", mock.url),
      });
      expect(manifest.run.status).toBe("complete");
      expect(manifest.counts_summary).toMatchObject({ business: 1, users: 3, removed_users: 1, transactions: 3, expenses: 1, fields: 1 });

      const userCalls = mock.requests.filter((r) => r.path.endsWith("/users")).map((r) => new URLSearchParams(r.search));
      expect(userCalls.some((p) => p.get("membership_status") === "removed")).toBe(true);
      expect(userCalls.filter((p) => p.get("page_token")).length).toBeGreaterThan(0);

      const tx = paramsOf(mock, "/transactions");
      expect(tx.get("initiated_after")).toBe("2025-01-01T00:00:00Z");
      expect(tx.get("initiated_before")).toBe("2025-02-01T00:00:00Z");
      const ex = paramsOf(mock, "/expenses");
      expect(ex.get("transaction_date_after")).toBe("2025-01-01");
      expect(ex.get("transaction_date_before")).toBe("2025-02-01");
      expect(paramsOf(mock, "/fields").get("include_retired")).toBe("true");
      expect(tx.get("page_size")).toBe("100");
    } finally {
      mock.stop();
    }
  });

  test("Rho's 429s are retried", async () => {
    const mock = startMockSource({ style: "rho", failTimes: 3, routes: { "/cards": [{ id: "c1" }] } });
    const out = await tmp("rho-429");
    try {
      const { manifest } = await runExport({
        config: cfg("rho", out, mock.url, { categories: ["cards"] }),
        credentials: credsFor("rho"),
        clientFactory: () => fastClient("rho", mock.url),
      });
      expect(manifest.counts_summary).toEqual({ cards: 1 });
    } finally {
      mock.stop();
    }
  });
});

describe("checkAccess", () => {
  test("reports ok / denied / unavailable per resource and finds the account name", async () => {
    const mock = startMockSource({
      style: "mercury",
      token: "secret-token:test-api-token",
      routes: {
        "/organization": { object: { legalBusinessName: "Acme Inc" }, key: "organization" },
        "/users": [{ userId: "u1" }],
        "/accounts": [{ id: "a1" }],
        "/account/a1/statements": [],
        "/cards": { status: 403, body: "forbidden" },
      },
    });
    try {
      const s = SOURCES.mercury;
      const { access, accountName } = await checkAccess(fastClient("mercury", mock.url), s, Object.keys(s.resources));
      expect(accountName).toBe("Acme Inc");
      expect(access.users).toEqual({ status: "ok" });
      expect(access.statements).toEqual({ status: "ok" });
      expect(access.cards!.status).toBe("denied");
      expect(access.invoices!.status).toBe("unavailable");
      // probes use the smallest page
      expect(paramsOf(mock, "/users").get("limit")).toBe("1");
      // the child was probed with the first parent's id
      expect(mock.requests.some((r) => r.path.endsWith("/account/a1/statements"))).toBe(true);
    } finally {
      mock.stop();
    }
  });

  test("children of an inaccessible or empty parent are unchecked, not probed", async () => {
    const mock = startMockSource({ style: "brex", routes: { "/v2/accounts/cash": { status: 403 } } });
    try {
      const { access } = await checkAccess(fastClient("brex", mock.url), SOURCES.brex, ["cash_accounts", "cash_statements"]);
      expect(access.cash_accounts!.status).toBe("denied");
      expect(access.cash_statements).toEqual({ status: "unchecked" });
    } finally {
      mock.stop();
    }
  });

  test("bad credentials throw rather than reporting every resource denied", async () => {
    const mock = startMockSource({ style: "rho", routes: { "/business": { object: {} } } });
    try {
      const err = (await checkAccess(fastClient("rho", mock.url, { apiToken: "nope" }), SOURCES.rho, ["business"]).catch((e: unknown) => e)) as SourceError;
      expect(err.kind).toBe("auth");
    } finally {
      mock.stop();
    }
  });
});

describe("config", () => {
  test("config.example.yml loads, with commented-out blocks treated as absent", () => {
    const config = loadConfig("config.example.yml");
    expect(config.source.system).toBe("ramp");
    expect(config.export.filters).toEqual({});
    expect(config.export.categories).toBeUndefined();
    expect(config.runtime.rate_limit_rps).toBeUndefined();
  });

  test("credentials come from each source's env vars", () => {
    expect(loadCredentials(SOURCES.mercury, { MERCURY_API_TOKEN: " tok " })).toEqual({ apiToken: "tok" });
    expect(() => loadCredentials(SOURCES.ramp, { RAMP_CLIENT_ID: "x" })).toThrow(/RAMP_CLIENT_SECRET/);
  });
});

describe("API base", () => {
  test("the {SOURCE}_API_BASE env var redirects the default client (CLI and UI alike)", async () => {
    const mock = startMockSource({ style: "rho", routes: { "/cards": [{ id: "c1" }] } });
    const out = await tmp("rho-env");
    process.env.RHO_API_BASE = mock.url;
    try {
      const { manifest } = await runExport({ config: cfg("rho", out, undefined, { categories: ["cards"] }), credentials: credsFor("rho") });
      expect(manifest.counts_summary).toEqual({ cards: 1 });
      expect(mock.requests.length).toBeGreaterThan(0);
    } finally {
      delete process.env.RHO_API_BASE;
      mock.stop();
    }
  });
});

describe("cancellation", () => {
  test("aborting mid-export removes the half-written bundle", async () => {
    const abort = new AbortController();
    const mock = startMockSource({ style: "rho", pageSize: 1, routes: { "/cards": [{ id: "c1" }, { id: "c2" }, { id: "c3" }] } });
    const out = await tmp("rho-abort");
    try {
      const run = runExport({
        config: cfg("rho", out, mock.url, { categories: ["cards"] }),
        credentials: credsFor("rho"),
        clientFactory: (_s, signal) => fastClient("rho", mock.url, credsFor("rho"), signal),
        signal: abort.signal,
        onProgress: (e) => {
          if (e.type === "resource_start") abort.abort();
        },
      });
      await expect(run).rejects.toBeDefined();
      expect(await readdir(join(out, "rho"))).toEqual([]);
    } finally {
      mock.stop();
    }
  });
});
