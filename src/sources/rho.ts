import type { SourceDef } from "./types";

/**
 * Rho API v1 (https://docs.rho.co). Shapes taken from Rho's published OpenAPI spec:
 * lists return `{ <key>: [], page: { next_page_token } }`. Money is `{ amount: <minor units>, currency }`.
 * Rho asks clients to stay under ~1 request/second per token, without bursts.
 */
export const rho: SourceDef = {
  id: "rho",
  label: "Rho",
  tagline: "Business banking, cards, and expense management",
  apiVersion: "v1",
  apiBase: "https://rhoapi.rho.co/api/v1",
  apiBaseEnv: "RHO_API_BASE",
  rateLimitRps: 0.9,
  credentials: [{ key: "apiToken", label: "API access token", env: "RHO_API_TOKEN", secret: true, placeholder: "Paste your Rho token" }],
  auth: { kind: "bearer", tokenKey: "apiToken" },
  pagination: { kind: "page_token" },
  pageSize: { param: "page_size", value: "100", probe: "1" },
  resources: {
    business: { label: "Business", one: "Business", path: "/business", shape: "object", scope: "businesses:read" },
    users: { label: "Users", one: "User", path: "/users", key: "users", scope: "users:read" },
    // Rho leaves removed members out of /users unless asked; old transactions still point at them.
    removed_users: {
      label: "Removed users",
      one: "Removed user",
      path: "/users",
      key: "users",
      scope: "users:read",
      query: { membership_status: "removed" },
    },
    accounts: { label: "Accounts", one: "Account", path: "/accounts", key: "accounts", scope: "accounts:read" },
    credit_programs: { label: "Credit programs", one: "Credit program", path: "/credit-programs", shape: "list", key: "credit_programs", scope: "credit:read" },
    statements: { label: "Statements", one: "Statement", path: "/statements", key: "statements", scope: "statements:read" },
    // `initiated_*` keeps pending transactions; `posted_*` would drop them.
    transactions: {
      label: "Transactions",
      one: "Transaction",
      path: "/transactions",
      key: "transactions",
      scope: "transactions:read",
      dateFilter: {
        from: { param: "initiated_after", format: "datetime" },
        to: { param: "initiated_before", format: "datetime_exclusive" },
      },
    },
    cards: { label: "Cards", one: "Card", path: "/cards", key: "cards", scope: "cards:read" },
    scheduled_payments: {
      label: "Scheduled payments",
      one: "Scheduled payment",
      path: "/scheduled-transactions",
      key: "scheduled_transactions",
      scope: "transactions:read",
    },
    expenses: {
      label: "Expenses",
      one: "Expense",
      path: "/expenses",
      key: "expenses",
      scope: "expenses:read",
      dateFilter: {
        from: { param: "transaction_date_after", format: "date" },
        to: { param: "transaction_date_before", format: "date_exclusive" },
      },
    },
    reimbursements: {
      label: "Reimbursements",
      one: "Reimbursement",
      path: "/reimbursements",
      key: "reimbursements",
      scope: "reimbursements:read",
      dateFilter: {
        from: { param: "transaction_date_after", format: "date" },
        to: { param: "transaction_date_before", format: "date_exclusive" },
      },
    },
    fields: { label: "Custom fields", one: "Custom field", path: "/fields", key: "fields", scope: "fields:read", query: { include_retired: "true" } },
    customers: { label: "Customers", one: "Customer", path: "/invoicing/customers", key: "customers", scope: "invoicing:read" },
    invoices: { label: "Invoices", one: "Invoice", path: "/invoicing/invoices", key: "invoices", scope: "invoicing:read" },
  },
  categories: [
    { id: "users", label: "Team", description: "Your business profile and every user, including removed ones", resources: ["business", "users", "removed_users"] },
    {
      id: "accounts",
      label: "Accounts & transactions",
      description: "Accounts, credit programs, statements, and every transaction",
      resources: ["accounts", "credit_programs", "statements", "transactions"],
    },
    { id: "cards", label: "Cards", description: "Physical and virtual cards with their limits and controls", resources: ["cards"] },
    { id: "vendors", label: "Scheduled payments", description: "Recurring and scheduled payments to the people you pay", resources: ["scheduled_payments"] },
    { id: "expenses", label: "Expenses", description: "Expenses, reimbursements, and your custom coding fields", resources: ["expenses", "reimbursements", "fields"] },
    { id: "invoicing", label: "Invoicing", description: "Customers and the invoices you've sent them", resources: ["customers", "invoices"] },
  ],
  setup: {
    url: "https://app.rho.co/settings/access-tokens",
    linkLabel: "Open Rho",
    steps: [
      "Sign in as an owner or admin and go to Settings → Configurations → Access Tokens",
      "Create a token and select every read scope",
      "Set any expiration you like — a week is plenty for one export",
    ],
    scopesNote: "Rho shows the token once — copy it before you close the dialog.",
  },
  account: { resource: "business", name: (r) => r.legal_name },
};
