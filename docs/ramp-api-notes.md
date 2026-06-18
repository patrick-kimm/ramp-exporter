# Ramp API — verified facts

Source: `https://docs.ramp.com/openapi/developer-api.json` (verified 2026-06-17).
Production server: `https://api.ramp.com`. These are the authoritative shapes the
exporter codes against — not assumptions.

## Auth
- OAuth2 **client-credentials** flow is supported. `tokenUrl = https://api.ramp.com/developer/v1/token`.
- Scope passed in the token request; scopes are `resource:read` slugs (underscores).
- A Customer **admin** self-serves the app: Ramp dashboard → Settings → Developer (sandbox needs an account manager; production read of own data does not).

## Pagination
- Response envelope: `{ "data": [ ... ], "page": { "next": <absolute-url | null> } }`.
- Query params: `start` (id of last entity of the previous page) and `page_size` (2–100, default 20).
- Follow `page.next` until null. Our `RampClient.paginate` does exactly this. ✓

## GET list endpoints + scopes
| Resource | Path | Scope |
|---|---|---|
| users | `/developer/v1/users` | `users:read` |
| departments | `/developer/v1/departments` | `departments:read` |
| locations | `/developer/v1/locations` | `locations:read` |
| entities | `/developer/v1/entities` | `entities:read` |
| cards | `/developer/v1/cards` | `cards:read` |
| spend limits → use **funds** (legacy alias, same entities) | `/developer/v1/limits` | `limits:read` |
| spend programs | `/developer/v1/spend-programs` | `spend_programs:read` |
| funds | `/developer/v1/funds` | `funds:read` |
| vendors (bill-pay) | `/developer/v1/vendors` | `vendors:read` |
| vendor contacts (sub-resource, per vendor) | `/developer/v1/vendors/{id}/contacts` | `vendors:read` |
| vendors (accounting) | `/developer/v1/accounting/vendors` | `accounting:read` |
| bills | `/developer/v1/bills` | `bills:read` |
| transactions | `/developer/v1/transactions` | `transactions:read` |

Note: scope slugs use underscores (`spend_programs:read`); some paths use hyphens (`/spend-programs`). We name exporter resources after the **path segment** so the bundle mirrors Ramp (raw-faithful): `cards`, `limits`, `spend-programs`, `vendors`, `bills`, `transactions`.

## Masking (confirms our deferrals)
- **Card PAN**: not on `/cards`. Full PAN only via `/vault/cards/{id}` (scope `cards:read_vault`), which we do NOT request → cards arrive masked (`last_four` only).
- **Vendor bank account**: `/vendors/{id}/accounts` exposes `account_number_last_four` only. Full account/routing numbers are not retrievable → vendor bank-detail re-collection is unavoidable for operational cutover (deferred to v2).

## Object-shape notes
- Spend Limit **`balance`** lives on the *detail* resource (`ApiSpendLimitDetailResource`), not necessarily the `/limits` list. v1 captures whatever the list returns; per-limit balance enrichment is a later concern.
- Card spending restrictions (`amount`, `interval`, `transaction_amount_limit`) are fields on the card/limit — confirms there is **no separate Policy object**.
- Payment **rail** = `payment_method` on bill payments (`ApiBillPayment`), alongside `amount`. CORRECTION (from live data): the `/vendors` object **does** carry native per-vendor spend totals — `total_spend_ytd` / `_last_30_days` / `_last_365_days` / `_all_time` (each `{amount, minor_unit_conversion_rate, currency_code}`) plus `default_payment_method`. So the Cockpit rollup can read these directly instead of summing the ledger (the earlier "no native vendor total" claim was an OpenAPI-truncation artifact).
- **Date filters require full ISO-8601 datetimes** (confirmed live 2026-06-17): bare `YYYY-MM-DD` returns `422 DEVELOPER_7001 "Not a valid datetime"`. bills use `from_issued_date`/`to_issued_date`; transactions use `from_date`/`to_date`. The exporter normalizes via `toRampDatetime` (from→`T00:00:00Z`, to→`T23:59:59Z`).

## Migration field sources (verified 2026-06-18)
- **Vendor email** → not on the vendor object; lives on `/vendors/{id}/contacts` (per-vendor sub-resource, `vendors:read`; fields `email`, `first_name`, `last_name`, `phone`, `is_default`). The exporter pulls it as the `vendor_contacts` resource (each row tagged with `vendor_id`).
- **Spend-category names** → NOT available: there is no category endpoint. Cards/funds expose `blocked_category_codes`/`allowed_category_codes` (raw codes) only; names must be resolved downstream from a static table.
- **Vendor↔transaction link** → `vendor.merchant_id` == `transaction.merchant_id` (both already extracted; per-vendor txn counts are a downstream join, not a new resource).
- **User status enum**: `USER_ACTIVE`, `INVITE_PENDING`, `INVITE_EXPIRED`, `USER_DRAFT`, `USER_ONBOARDING`, `USER_INACTIVE` (terminated/deactivated), `USER_SUSPENDED`.

## Card / spend-control model (cards category)
The card config is a quartet — `cards` + `limits` + `spend-programs` + `funds` — all scoped to an **Entity**:

```
Entity
└─ Card  (card_program_id → opaque, NO read endpoint)
     ├─ cardholder_id → User
     └─ lives in → Limit  OR  Fund        (discovered via Limit.cards[] / Fund.cards[])
                      └─ spend_program_id → Spend Program (template)
                      └─ balance · restrictions · members/users
Transaction → card_id · limit_id · fund_id · spend_program_id · merchant_id · statement_id · entity_id
```

- **Fund == Limit** (verified live 2026-06-17): `/funds` and `/limits` return the **same entities** (identical ids). `/limits` is the **legacy alias** — Ramp rebranded "spend limits" → "Funds" under Spend Controls. Only the field names differ: `users`→`members`, `restrictions`→`spending_restrictions`, `has_program_overridden`→`overrides_spend_program` (and slightly different `cards`/`permitted_spend_types` representations). **We export `funds` only** (canonical); exporting `limits` too would be duplicate data. A Fund is a balance-bearing bucket (`balance` cleared/pending/total, `members[]`, `cards[]`, `spending_restrictions`, `spend_program_id`) — Ramp's analog to a **Slash virtual account / subaccount**; the card→bucket link is `Fund.cards[]`. Value-mapping (Fund → Virtual Account) lives downstream in the Cockpit's Mappings.
- The card→bucket link is **NOT on the Card object** — resolve via `Fund.cards[]` / `Limit.cards[]`, or `Transaction.fund_id` (transactions carry `fund_id`, `limit_id`, `spend_program_id` for per-bucket reconciliation).
- `card_program_id` (physical/virtual card program) has **no read endpoint** — captured as an opaque id only.
- **Entities** (`/entities`, `entities:read`): every Card/Limit/Fund/User references `entity_id`; entity has `is_primary`. Exported in the **users** category (org structure).
- Deferred (v2): `statements` (billing history), `memos` (txn annotations), `merchants` (txn lookup — pair with the ledger), `reimbursements` (separate spend type). Skipped: `cashbacks` (Ramp-proprietary, not portable), `vault/cards` (full PAN).
