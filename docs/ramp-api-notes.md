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
| cards | `/developer/v1/cards` | `cards:read` |
| spend limits | `/developer/v1/limits` | `limits:read` |
| spend programs | `/developer/v1/spend-programs` | `spend_programs:read` |
| vendors (bill-pay) | `/developer/v1/vendors` | `vendors:read` |
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
- Payment **rail** = `payment_method` on bill payments (`ApiBillPayment`), alongside `amount`. Per-vendor spend rollups derive from bills/transactions (Ramp exposes no native vendor total).
- `funds:read` is a real scope — "funds" is a distinct Ramp funding concept, separate from a limit's balance. Out of v1.
- **Date filters require full ISO-8601 datetimes** (confirmed live 2026-06-17): bare `YYYY-MM-DD` returns `422 DEVELOPER_7001 "Not a valid datetime"`. bills use `from_issued_date`/`to_issued_date`; transactions use `from_date`/`to_date`. The exporter normalizes via `toRampDatetime` (from→`T00:00:00Z`, to→`T23:59:59Z`).
