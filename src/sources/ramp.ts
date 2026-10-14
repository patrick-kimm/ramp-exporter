import type { SourceDef } from "./types";

/** Endpoint facts verified against Ramp's OpenAPI — see docs/ramp-api-notes.md. */
export const ramp: SourceDef = {
  id: "ramp",
  label: "Ramp",
  tagline: "Corporate cards, bill pay, and spend management",
  apiVersion: "developer/v1",
  apiBase: "https://api.ramp.com/developer/v1",
  apiBaseEnv: "RAMP_API_BASE",
  rateLimitRps: 8,
  credentials: [
    { key: "clientId", label: "Client ID", env: "RAMP_CLIENT_ID", secret: false, placeholder: "ramp_id_…" },
    { key: "clientSecret", label: "Client Secret", env: "RAMP_CLIENT_SECRET", secret: true, placeholder: "ramp_sec_…" },
  ],
  auth: { kind: "client_credentials", tokenPath: "/token", idKey: "clientId", secretKey: "clientSecret" },
  pagination: { kind: "next_url" },
  pageSize: { param: "page_size", value: "100", probe: "2" },
  resources: {
    users: { label: "Users", one: "User", path: "/users", scope: "users:read" },
    departments: { label: "Departments", one: "Department", path: "/departments", scope: "departments:read" },
    locations: { label: "Locations", one: "Location", path: "/locations", scope: "locations:read" },
    entities: { label: "Business entities", one: "Business entity", path: "/entities", scope: "entities:read" },
    cards: { label: "Cards", one: "Card", path: "/cards", scope: "cards:read" },
    "spend-programs": { label: "Spend programs", one: "Spend program", path: "/spend-programs", scope: "spend_programs:read" },
    // /limits is the legacy alias of /funds (same entities, renamed fields) — we export funds only.
    funds: { label: "Funds", one: "Fund", path: "/funds", scope: "funds:read" },
    vendors: { label: "Vendors", one: "Vendor", path: "/vendors", scope: "vendors:read" },
    vendor_contacts: {
      label: "Vendor contacts",
      one: "Vendor contact",
      scope: "vendors:read",
      parent: { resource: "vendors", path: (id) => `/vendors/${id}/contacts`, linkField: "vendor_id" },
    },
    // Ramp's date filters require a full ISO datetime; a bare YYYY-MM-DD returns 422.
    bills: {
      label: "Bills",
      one: "Bill",
      path: "/bills",
      scope: "bills:read",
      dateFilter: {
        from: { param: "from_issued_date", format: "datetime" },
        to: { param: "to_issued_date", format: "datetime" },
      },
    },
    transactions: {
      label: "Card transactions",
      one: "Card transaction",
      path: "/transactions",
      scope: "transactions:read",
      dateFilter: {
        from: { param: "from_date", format: "datetime" },
        to: { param: "to_date", format: "datetime" },
      },
    },
  },
  categories: [
    { id: "users", label: "Users", description: "People, departments, locations, and entities", resources: ["users", "departments", "locations", "entities"] },
    { id: "cards", label: "Cards", description: "Cards, spend programs, and funds", resources: ["cards", "spend-programs", "funds"] },
    { id: "vendors", label: "Vendors", description: "Vendors, contacts, bills, and transactions", resources: ["vendors", "vendor_contacts", "bills", "transactions"] },
  ],
  setup: {
    url: "https://app.ramp.com",
    linkLabel: "Open Ramp",
    steps: [
      "Go to Settings → Developer → Create app",
      "Choose Client credentials as the grant type",
      "Turn on all of these read scopes",
    ],
    scopesNote: "Ramp checks every scope when you connect, so a missing one fails right away.",
  },
  account: { resource: "entities", name: (r) => r.entity_name ?? r.name },
};
