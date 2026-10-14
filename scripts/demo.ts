#!/usr/bin/env bun
/**
 * Runs the UI against local fake APIs for every platform, with synthetic data —
 * for demos and UI work without real credentials. Any credentials work except
 * for bearer tokens, which must be "demo-token".
 *
 *   bun run scripts/demo.ts
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startUiServer } from "../src/ui/server";
import { startMockSource, type MockRoute } from "../test/mock-source";

const TOKEN = "demo-token";
const people = ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Linus Pauling", "Mae Jemison", "Claude Shannon", "Hedy Lamarr"];
const merchants = ["Delta Air Lines", "AWS", "Figma", "Notion", "Uber", "Blue Bottle Coffee", "WeWork", "Google Workspace", "Slack", "Hilton"];
const split = (n: string) => ({ first: n.split(" ")[0]!, last: n.split(" ").slice(1).join(" ") });
const day = (i: number) => new Date(Date.UTC(2025, 0, 1) + i * 86_400_000 * 1.7).toISOString().slice(0, 10);
const range = (n: number) => Array.from({ length: n }, (_, i) => i);
const cents = (i: number) => ((i * 7919) % 250_000) + 499;

function ramp(): Record<string, MockRoute> {
  const users = people.map((p, i) => ({ id: `ru${i}`, first_name: split(p).first, last_name: split(p).last, email: `${split(p).first.toLowerCase()}@acme.co`, role: i ? "BUSINESS_USER" : "BUSINESS_ADMIN", department_id: `rd${i % 3}`, status: "USER_ACTIVE" }));
  return {
    "/users": users,
    "/departments": ["Engineering", "Sales", "Operations"].map((name, i) => ({ id: `rd${i}`, name })),
    "/locations": [{ id: "rl0", name: "New York", entity_id: "re0" }],
    "/entities": [{ id: "re0", entity_name: "Acme Corp", currency: "USD", is_primary: true }],
    "/cards": users.map((u, i) => ({ id: `rc${i}`, display_name: `${u.first_name}'s card`, cardholder_id: u.id, last_four: String(4000 + i), is_physical: i % 2 === 0, state: "ACTIVE" })),
    "/spend-programs": [{ id: "rsp0", display_name: "Travel & entertainment", description: "Flights, hotels, and client meals" }],
    "/funds": [{ id: "rf0", display_name: "Marketing", spend_program_id: "rsp0" }],
    "/vendors": merchants.map((name, i) => ({ id: `rv${i}`, name, entity_id: "re0", created_at: `${day(i)}T00:00:00Z` })),
    ...Object.fromEntries(merchants.map((m, i) => [`/vendors/rv${i}/contacts`, [{ id: `rvc${i}`, first_name: "Accounts", last_name: "Payable", email: `ap@${m.toLowerCase().replace(/\W/g, "")}.com` }]])),
    "/bills": range(24).map((i) => ({ id: `rb${i}`, vendor: { id: `rv${i % 10}`, remote_name: merchants[i % 10] }, invoice_number: `INV-${1000 + i}`, issued_at: day(i), due_at: day(i + 18), amount: { amount: cents(i) * 10, currency_code: "USD" }, payment_status: i % 4 ? "PAID" : "OPEN" })),
    "/transactions": range(320).map((i) => ({ id: `rt${i}`, merchant_name: merchants[i % 10], user_transaction_time: `${day(i % 200)}T15:00:00Z`, card_holder: { user_id: `ru${i % 8}`, ...{ first_name: split(people[i % 8]!).first, last_name: split(people[i % 8]!).last } }, amount: cents(i) / 100, currency_code: "USD", state: "CLEARED" })),
  };
}

function mercury(): Record<string, MockRoute> {
  const accounts = [
    { id: "ma0", name: "Mercury Checking ••1234", nickname: "Operating", kind: "checking", accountNumber: "202211111234", routingNumber: "091311229", currentBalance: 1_284_331.12, availableBalance: 1_280_000, status: "active", type: "mercury" },
    { id: "ma1", name: "Mercury Savings ••5678", nickname: "Reserve", kind: "savings", accountNumber: "202299995678", routingNumber: "091311229", currentBalance: 3_500_000, availableBalance: 3_500_000, status: "active", type: "mercury" },
  ];
  return {
    "/organization": { object: { id: "mo", legalBusinessName: "Acme Corp", kind: "corporation", ein: "12-3456789" }, key: "organization" },
    "/users": people.slice(0, 5).map((p, i) => ({ userId: `mu${i}`, firstName: split(p).first, lastName: split(p).last, email: `${split(p).first.toLowerCase()}@acme.co`, organizationRole: i ? "user" : "admin" })),
    "/accounts": accounts,
    "/credit": { list: [{ id: "mcr0", currentBalance: 18_220.4, availableBalance: 81_779.6, status: "active" }], key: "accounts", unpaged: true },
    "/treasury": { list: [{ id: "mt0", currentBalance: 2_000_000, availableBalance: 2_000_000, status: "active" }], key: "accounts" },
    "/account/ma0/statements": range(6).map((i) => ({ id: `ms0${i}`, startDate: `2025-0${i + 1}-01`, endDate: `2025-0${i + 1}-28`, endingBalance: 1_000_000 + i * 40_000 })),
    "/account/ma1/statements": range(6).map((i) => ({ id: `ms1${i}`, startDate: `2025-0${i + 1}-01`, endDate: `2025-0${i + 1}-28`, endingBalance: 3_500_000 })),
    "/transactions": range(180).map((i) => ({ id: `mx${i}`, accountId: accounts[i % 2]!.id, counterpartyName: merchants[i % 10], postedAt: `${day(i)}T12:00:00Z`, amount: i % 9 === 0 ? 25_000 : -(cents(i) / 100), kind: i % 9 === 0 ? "externalTransfer" : "debitCardTransaction", status: "sent" })),
    "/categories": [{ id: "mc0", name: "Software" }, { id: "mc1", name: "Travel" }],
    "/cards": people.slice(0, 5).map((p, i) => ({ id: `mcard${i}`, userId: `mu${i}`, nameOnCard: p, nickname: i ? null : "Ads", lastFour: String(7000 + i), kind: i % 2 ? "virtual" : "physical", status: "active" })),
    "/recipients": merchants.slice(0, 6).map((name, i) => ({ id: `mr${i}`, name, emails: [`billing@${name.toLowerCase().replace(/\W/g, "")}.com`], defaultPaymentMethod: i % 2 ? "ach" : "domesticWire", dateLastPaid: day(i * 10), status: "active", electronicRoutingInfo: { accountNumber: `99887766${i}`, routingNumber: "021000021" } })),
    "/ar/customers": [{ id: "mcu0", name: "Globex", email: "ap@globex.com" }, { id: "mcu1", name: "Initech", email: "billing@initech.com" }],
    "/ar/invoices": range(5).map((i) => ({ id: `mi${i}`, customerId: `mcu${i % 2}`, invoiceNumber: `A-${200 + i}`, invoiceDate: day(i * 12), dueDate: day(i * 12 + 30), amount: 12_500 + i * 1000, status: i ? "paid" : "unpaid" })),
  };
}

function brex(): Record<string, MockRoute> {
  const users = people.map((p, i) => ({ id: `bu${i}`, first_name: split(p).first, last_name: split(p).last, email: `${split(p).first.toLowerCase()}@acme.co`, department_id: `bd${i % 2}`, status: "ACTIVE" }));
  const money = (i: number) => ({ amount: cents(i), currency: "USD" });
  return {
    "/v2/company": { object: { id: "bco", legal_name: "Acme Corp", accountType: "BREX_EMPOWER" } },
    "/v2/users": users,
    // staged so the demo shows how a missing permission is handled
    "/v2/departments": { status: 403, body: '{"message":"Token is missing the departments.readonly scope"}' },
    "/v2/locations": [{ id: "bl0", name: "San Francisco" }],
    "/v2/titles": [{ id: "bt0", name: "Engineer" }, { id: "bt1", name: "Account Executive" }],
    "/v2/cost_centers": [{ id: "bcc0", name: "R&D" }],
    "/v2/legal_entities": [{ id: "ble0", displayName: "Acme Corp", status: "VERIFIED" }],
    "/v2/cards": users.map((u, i) => ({ id: `bc${i}`, card_name: `${u.first_name}'s card`, owner: { type: "USER", user_id: u.id }, last_four: String(5100 + i), card_type: i % 2 ? "VIRTUAL" : "PHYSICAL", status: "ACTIVE" })),
    "/v2/budgets": [{ budget_id: "bb0", name: "Team offsites", period_type: "QUARTERLY", limit: { amount: 5_000_000, currency: "USD" }, budget_status: "APPROVED" }],
    "/v2/spend_limits": [{ id: "bsl0", name: "SaaS", period_recurrence_type: "MONTHLY", status: "ACTIVE" }],
    "/v1/budget_programs": [],
    "/v2/accounts/card": { array: [{ id: "bca0", status: "ACTIVE", current_balance: { amount: 4_218_00, currency: "USD" }, available_balance: { amount: 95_782_00, currency: "USD" }, account_limit: { amount: 100_000_00, currency: "USD" } }] },
    "/v2/accounts/card/primary/statements": range(4).map((i) => ({ id: `bcs${i}`, period: { start_date: `2025-0${i + 1}-01`, end_date: `2025-0${i + 1}-28` }, start_balance: money(i), end_balance: money(i + 1) })),
    "/v2/transactions/card/primary": range(140).map((i) => ({ id: `bct${i}`, description: merchants[i % 10]!.toUpperCase(), amount: money(i), posted_at_date: day(i), type: "PURCHASE" })),
    "/v2/accounts/cash": [{ id: "bcash0", name: "Brex Business Account", status: "ACTIVE", account_number: "123456789012", routing_number: "121145349", current_balance: { amount: 812_000_00, currency: "USD" }, available_balance: { amount: 812_000_00, currency: "USD" }, primary: true }],
    "/v2/accounts/cash/bcash0/statements": range(4).map((i) => ({ id: `bss${i}`, period: { start_date: `2025-0${i + 1}-01`, end_date: `2025-0${i + 1}-28` }, start_balance: money(i * 3), end_balance: money(i * 3 + 1) })),
    "/v2/transactions/cash/bcash0": range(40).map((i) => ({ id: `bxt${i}`, description: `Transfer ${i}`, amount: { amount: (i % 3 ? -1 : 1) * cents(i) * 20, currency: "USD" }, posted_at_date: day(i * 4), type: "ACH" })),
    "/v1/linked_accounts": [{ id: "bla0", bank_details: { name: "Chase" }, last_four: "9911" }],
    "/v1/vendors": merchants.slice(0, 5).map((m, i) => ({ id: `bv${i}`, company_name: m, email: `ap@${m.toLowerCase().replace(/\W/g, "")}.com`, payment_accounts: [{ details: { type: "ACH", account_number: `55500011${i}`, routing_number: "026009593" } }] })),
    "/v1/transfers": range(12).map((i) => ({ id: `btr${i}`, display_name: merchants[i % 5], process_date: day(i * 6), payment_type: "ACH", amount: money(i * 31), status: "PROCESSED" })),
    "/v1/expenses": range(90).map((i) => ({ id: `be${i}`, merchant: { raw_descriptor: merchants[i % 10] }, purchased_at: `${day(i)}T18:00:00Z`, user: { first_name: split(people[i % 8]!).first, last_name: split(people[i % 8]!).last }, purchased_amount: money(i), status: i % 6 ? "APPROVED" : "SUBMITTED", memo: "Client dinner" })),
  };
}

function rho(): Record<string, MockRoute> {
  const users = people.slice(0, 6).map((p, i) => ({ id: `hu${i}`, first_name: split(p).first, last_name: split(p).last, email: `${split(p).first.toLowerCase()}@acme.co`, role_name: i ? "Member" : "Owner", user_status: "active", membership_status: "active" }));
  const money = (i: number) => ({ amount: cents(i), currency: "USD" });
  return {
    "/business": { object: { id: "hb", legal_name: "Acme Corp", dba: "Acme" } },
    "/users": users,
    "/users?membership_status=removed": [{ id: "hu9", first_name: "Former", last_name: "Employee", email: "former@acme.co", role_name: "Member", user_status: "inactive", membership_status: "removed" }],
    "/accounts": [{ id: "ha0", account_name: "Operating", account_type: "checking", account_number_last_4: "4321", balance: { amount: 642_500_00, currency: "USD" } }],
    "/credit-programs": { list: [{ id: "hcp0", name: "Rho Corporate Card", credit_limit: { amount: 250_000_00, currency: "USD" }, repayment_cadence: "monthly" }], key: "credit_programs", unpaged: true },
    "/statements": range(4).map((i) => ({ id: `hs${i}`, period_start: `2025-0${i + 1}-01`, period_end: `2025-0${i + 1}-28`, statement_type: "monthly", available_at: `2025-0${i + 2}-02` })),
    "/transactions": range(60).map((i) => ({ id: `ht${i}`, counterparty_name: merchants[i % 10], initiated_at: `${day(i)}T10:00:00Z`, account_name: "Operating", amount: { amount: -cents(i), currency: "USD" }, status: "posted" })),
    "/cards": users.map((u, i) => ({ id: `hc${i}`, name: `${u.first_name}'s card`, cardholder: { user_id: u.id, first_name: u.first_name, last_name: u.last_name }, last_4: String(6100 + i), type: i % 2 ? "virtual" : "physical", status: "active" })),
    "/scheduled-transactions": { list: [{ id: "hst0", counterparty: { id: "x", name: "WeWork" }, amount: money(80_000), payment_type: "ach", schedule: { frequency: "monthly" } }], key: "scheduled_transactions" },
    "/expenses": range(30).map((i) => ({ id: `he${i}`, merchant_name: merchants[i % 10], transaction_date: day(i * 2), user_id: `hu${i % 6}`, amount: money(i), approval_status: i % 5 ? "approved" : "pending" })),
    "/reimbursements": range(6).map((i) => ({ id: `hr${i}`, merchant_name: "Uber", transaction_date: day(i * 9), user_id: `hu${i}`, amount: money(i * 3), payment_status: "paid" })),
    "/fields": [{ id: "hf0", name: "Project", type: "select", status: "active" }],
    "/invoicing/customers": [{ id: "hcu0", legal_name: "Globex", email: "ap@globex.com", created_at: "2024-11-02T00:00:00Z" }],
    "/invoicing/invoices": range(3).map((i) => ({ id: `hi${i}`, customer: { legal_name: "Globex" }, invoice_number: `R-${30 + i}`, date: day(i * 20), due_date: day(i * 20 + 30), total: { amount: 1_800_000, currency: "USD" }, status: i ? "paid" : "sent" })),
  };
}

const mocks = {
  ramp: startMockSource({ style: "ramp", pageSize: 50, routes: ramp() }),
  mercury: startMockSource({ style: "mercury", pageSize: 50, token: `secret-token:${TOKEN}`, routes: mercury() }),
  brex: startMockSource({ style: "brex", pageSize: 50, token: TOKEN, routes: brex() }),
  rho: startMockSource({ style: "rho", pageSize: 50, token: TOKEN, routes: rho() }),
};
const outputPath = await mkdtemp(join(tmpdir(), "slash-export-demo-"));
const ui = startUiServer({
  port: Number(process.env.PORT ?? 4747),
  outputPath,
  rateLimitRps: 200,
  apiBases: Object.fromEntries(Object.entries(mocks).map(([id, m]) => [id, m.url])),
});
console.log(`Demo UI: ${ui.url}`);
console.log(`Ramp: any Client ID / Secret · Mercury, Brex, Rho: token "${TOKEN}"`);
console.log(`Bundles go to ${outputPath}`);
