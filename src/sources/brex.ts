import type { SourceDef } from "./types";

/**
 * Brex API (https://developer.brex.com). Shapes taken from Brex's published OpenAPI
 * specs: lists return `{ items: [], next_cursor }`. Money is `{ amount: <cents>, currency }`.
 */
export const brex: SourceDef = {
  id: "brex",
  label: "Brex",
  tagline: "Corporate cards, banking, and expense management",
  apiVersion: "v1+v2",
  apiBase: "https://api.brex.com",
  apiBaseEnv: "BREX_API_BASE",
  rateLimitRps: 8,
  credentials: [{ key: "apiToken", label: "User token", env: "BREX_API_TOKEN", secret: true, placeholder: "bxt_…" }],
  auth: { kind: "bearer", tokenKey: "apiToken" },
  pagination: { kind: "cursor" },
  pageSize: { param: "limit", value: "100", probe: "1" },
  resources: {
    company: { label: "Company", one: "Company", path: "/v2/company", shape: "object", scope: "companies.readonly" },
    users: { label: "Users", one: "User", path: "/v2/users", scope: "users.readonly", query: { load_custom_fields: "true" } },
    departments: { label: "Departments", one: "Department", path: "/v2/departments", scope: "departments.readonly" },
    locations: { label: "Locations", one: "Location", path: "/v2/locations", scope: "locations.readonly" },
    titles: { label: "Titles", one: "Title", path: "/v2/titles", scope: "titles.readonly" },
    cost_centers: { label: "Cost centers", one: "Cost center", path: "/v2/cost_centers", scope: "cost_centers.readonly" },
    legal_entities: { label: "Legal entities", one: "Legal entity", path: "/v2/legal_entities", scope: "legal_entities.readonly" },

    cards: { label: "Cards", one: "Card", path: "/v2/cards", scope: "cards.readonly" },
    budgets: { label: "Budgets", one: "Budget", path: "/v2/budgets", scope: "budgets.readonly", idField: "budget_id" },
    spend_limits: { label: "Spend limits", one: "Spend limit", path: "/v2/spend_limits", scope: "budgets.readonly" },
    budget_programs: { label: "Budget programs", one: "Budget program", path: "/v1/budget_programs", scope: "budgets.readonly" },

    card_accounts: { label: "Card accounts", one: "Card account", path: "/v2/accounts/card", shape: "array", scope: "accounts.card.readonly" },
    card_statements: { label: "Card statements", one: "Card statement", path: "/v2/accounts/card/primary/statements", scope: "statements.card.readonly" },
    // Brex filters card/cash transactions by posted date but has no upper bound, so `to` is applied locally.
    card_transactions: {
      label: "Card transactions",
      one: "Card transaction",
      path: "/v2/transactions/card/primary",
      scope: "transactions.card.readonly",
      dateFilter: { from: { param: "posted_at_start", format: "datetime" }, clientTo: "posted_at_date" },
    },
    cash_accounts: { label: "Cash accounts", one: "Cash account", path: "/v2/accounts/cash", scope: "accounts.cash.readonly", sensitive: true },
    cash_statements: {
      label: "Cash statements",
      one: "Cash statement",
      scope: "statements.cash.readonly",
      parent: { resource: "cash_accounts", path: (id) => `/v2/accounts/cash/${id}/statements`, linkField: "cash_account_id" },
    },
    cash_transactions: {
      label: "Cash transactions",
      one: "Cash transaction",
      scope: "transactions.cash.readonly",
      parent: { resource: "cash_accounts", path: (id) => `/v2/transactions/cash/${id}`, linkField: "cash_account_id" },
      dateFilter: { from: { param: "posted_at_start", format: "datetime" }, clientTo: "posted_at_date" },
    },
    linked_accounts: { label: "Linked bank accounts", one: "Linked bank account", path: "/v1/linked_accounts", scope: "linked_accounts.readonly" },

    vendors: { label: "Vendors", one: "Vendor", path: "/v1/vendors", scope: "vendors.readonly", sensitive: true },
    transfers: { label: "Payments", one: "Payment", path: "/v1/transfers", scope: "transfers.readonly" },

    expenses: {
      label: "Expenses",
      one: "Expense",
      path: "/v1/expenses",
      scope: "expenses.card.readonly",
      query: { "expand[]": ["merchant", "user", "budget"], load_custom_fields: "true" },
      dateFilter: {
        from: { param: "purchased_at_start", format: "datetime" },
        to: { param: "purchased_at_end", format: "datetime" },
      },
    },
  },
  categories: [
    {
      id: "users",
      label: "Team",
      description: "Company, users, departments, locations, titles, cost centers, and legal entities",
      resources: ["company", "users", "departments", "locations", "titles", "cost_centers", "legal_entities"],
    },
    { id: "cards", label: "Cards", description: "Cards, budgets, spend limits, and budget programs", resources: ["cards", "budgets", "spend_limits", "budget_programs"] },
    {
      id: "accounts",
      label: "Accounts & transactions",
      description: "Card and cash accounts, statements, transactions, and linked banks",
      resources: ["card_accounts", "card_statements", "card_transactions", "cash_accounts", "cash_statements", "cash_transactions", "linked_accounts"],
    },
    { id: "vendors", label: "Vendors & payments", description: "Vendors with their payment details, and the payments you've sent", resources: ["vendors", "transfers"] },
    { id: "expenses", label: "Expenses", description: "Every expense with its memo, category, receipts status, and custom fields", resources: ["expenses"] },
  ],
  setup: {
    url: "https://dashboard.brex.com",
    linkLabel: "Open Brex",
    steps: [
      "Sign in as an account admin and go to Settings → Developer",
      "Accept the developer API terms if Brex asks, then click Create token",
      "Give every data type Read access",
    ],
    scopesNote: "Brex shows the token once — copy it before you close the dialog.",
  },
  account: { resource: "company", name: (r) => r.legal_name },
};
