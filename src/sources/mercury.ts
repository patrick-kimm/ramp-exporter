import type { SourceDef } from "./types";

const PREFIX = "secret-token:";

/**
 * Mercury API v1 (https://docs.mercury.com/reference). Shapes taken from Mercury's
 * published OpenAPI spec: lists return `{ <key>: [], page: { nextPage } }` and page
 * forward with `start_after`. Amounts are dollars (numbers), not cents.
 */
export const mercury: SourceDef = {
  id: "mercury",
  label: "Mercury",
  tagline: "Business banking, cards, and invoicing",
  apiVersion: "v1",
  apiBase: "https://api.mercury.com/api/v1",
  apiBaseEnv: "MERCURY_API_BASE",
  rateLimitRps: 5,
  credentials: [
    { key: "apiToken", label: "API token", env: "MERCURY_API_TOKEN", secret: true, placeholder: "secret-token:mercury_production_…" },
  ],
  // Mercury's tokens include a `secret-token:` prefix that people often leave off when copying.
  auth: { kind: "bearer", tokenKey: "apiToken", normalize: (t) => (t.startsWith(PREFIX) ? t : `${PREFIX}${t}`) },
  pagination: { kind: "start_after" },
  pageSize: { param: "limit", value: "1000", probe: "1" },
  resources: {
    organization: { label: "Organization", one: "Organization", path: "/organization", shape: "object", key: "organization" },
    users: { label: "Users", one: "User", path: "/users", key: "users", idField: "userId" },
    accounts: { label: "Bank accounts", one: "Bank account", path: "/accounts", key: "accounts", sensitive: true },
    credit_accounts: { label: "Credit accounts", one: "Credit account", path: "/credit", shape: "list", key: "accounts" },
    treasury_accounts: { label: "Treasury accounts", one: "Treasury account", path: "/treasury", key: "accounts" },
    statements: {
      label: "Statements",
      one: "Statement",
      key: "statements",
      parent: { resource: "accounts", path: (id) => `/account/${id}/statements`, linkField: "accountId" },
    },
    // Without `start`, Mercury returns everything since the first transaction.
    transactions: {
      label: "Transactions",
      one: "Transaction",
      path: "/transactions",
      key: "transactions",
      dateFilter: { from: { param: "start", format: "date" }, to: { param: "end", format: "date" } },
    },
    categories: { label: "Custom categories", one: "Custom category", path: "/categories", key: "categories" },
    cards: { label: "Cards", one: "Card", path: "/cards", key: "cards" },
    recipients: { label: "Recipients", one: "Recipient", path: "/recipients", key: "recipients", sensitive: true },
    customers: { label: "Customers", one: "Customer", path: "/ar/customers", key: "customers" },
    invoices: { label: "Invoices", one: "Invoice", path: "/ar/invoices", key: "invoices" },
  },
  categories: [
    { id: "users", label: "Team", description: "Your organization and its users", resources: ["organization", "users"] },
    {
      id: "accounts",
      label: "Accounts & transactions",
      description: "Bank, credit, and treasury accounts, statements, and every transaction",
      resources: ["accounts", "credit_accounts", "treasury_accounts", "statements", "transactions", "categories"],
    },
    { id: "cards", label: "Cards", description: "Debit and credit cards with their limits", resources: ["cards"] },
    { id: "vendors", label: "Recipients", description: "Everyone you pay, with their payment details", resources: ["recipients"] },
    { id: "invoicing", label: "Invoicing", description: "Customers and the invoices you've sent them", resources: ["customers", "invoices"] },
  ],
  setup: {
    url: "https://app.mercury.com/settings/tokens",
    linkLabel: "Open Mercury",
    steps: [
      "Go to Settings → API Tokens → Create an API token",
      "Choose Read Only — it needs no IP allowlist",
      "Copy the token, including its secret-token: prefix",
    ],
  },
  account: { resource: "organization", name: (r) => r.legalBusinessName },
};
