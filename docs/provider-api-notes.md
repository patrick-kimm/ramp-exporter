# Mercury, Brex, and Rho API notes

Endpoint facts behind `src/sources/{mercury,brex,rho}.ts`, taken from each provider's published
OpenAPI spec. Ramp's are in [`ramp-api-notes.md`](ramp-api-notes.md). Every source is read-only:
the exporter only ever sends `GET` requests (plus Ramp's token request).

## Mercury

- **Spec**: ReadMe registry `https://dash.readme.com/api/v1/api-registry/ilz81omom1n4vx` · docs at [docs.mercury.com](https://docs.mercury.com/reference).
- **Base**: `https://api.mercury.com/api/v1` (override with `MERCURY_API_BASE`).
- **Auth**: `Authorization: Bearer secret-token:…`. People often copy the token without its
  `secret-token:` prefix, so the client adds it when it's missing. Read-only tokens need no IP allowlist;
  read-write tokens do.
- **Paging**: `{ <key>: [...], page: { nextPage } }`, forward with `start_after=<nextPage>`, `limit` ≤ 1000.
  `/credit` returns `{ accounts }` with no paging.
- **IDs**: `id` on everything except users (`userId`).
- **Dates**: `/transactions` takes `start` / `end` as `YYYY-MM-DD`, both inclusive. Without `start` it
  returns everything since the first transaction.
- **Money**: dollars as plain numbers (`-84.18`), not cents.
- **Sensitive**: accounts, statements, and recipients carry **full** account and routing numbers.
  They're exported verbatim, and the UI masks them on screen and warns.
- **Statements** are per account: `/account/{id}/statements`, tagged with `accountId` on export.

## Brex

- **Specs**: `https://developer.brex.com/_spec/openapi/{team_api,transactions_api,expenses_api,payments_api,budgets_api}.json`.
- **Base**: `https://api.brex.com` (override with `BREX_API_BASE`). Mixes `/v1` and `/v2` paths.
- **Auth**: user token (`bxt_…`) as `Bearer`. Each endpoint requires its own `*.readonly` scope;
  `resources[].scope` in `brex.ts` lists them, and a 403 marks just that resource skipped.
- **Paging**: `{ items, next_cursor }`, forward with `cursor`, `limit` 100. `/v2/accounts/card`
  returns a bare array, and `/v2/company` returns a single object.
- **IDs**: `id`, except budgets (`budget_id`).
- **Dates**: card and cash transactions accept only `posted_at_start`; the end of the range is applied
  locally on `posted_at_date`. Expenses take `purchased_at_start` and `purchased_at_end`.
- **Money**: `{ amount: <cents>, currency }`.
- **Sensitive**: cash accounts (`account_number`, `routing_number`) and vendors (`payment_accounts`).
- **Expenses** are fetched with `expand[]=merchant,user,budget` and `load_custom_fields=true`, so a
  single file carries memos, categories, and custom fields.

## Rho

- **Spec**: `https://docs.rho.co/_bundle/api/v1/openapi.json?download`.
- **Base**: `https://rhoapi.rho.co/api/v1` (override with `RHO_API_BASE`).
- **Auth**: access token as `Bearer`, scoped per resource (`users:read`, `transactions:read`, …).
  403s are RFC 9457 problem details and don't name the missing scope, so the scope comes from `rho.ts`.
- **Rate limit**: about 60 requests a minute, and Rho asks clients not to burst. The exporter paces
  at 0.9 requests a second, so connecting (one probe per resource) takes about 20 seconds.
- **Paging**: `{ <key>: [...], page: { next_page_token } }`, forward with `page_token`, `page_size` ≤ 100.
  `/credit-programs` has no paging.
- **Dates**: `initiated_before` and `transaction_date_before` are **exclusive**, so the exporter sends
  the day after the chosen end date. `initiated_*` is used instead of `posted_*` so pending
  transactions are kept.
- **Users**: `/users` leaves out removed members unless `membership_status=removed` is passed, so both
  are exported (`users`, `removed_users`), because old transactions still point at removed users.
- **Money**: `{ amount: <minor units>, currency }`.
- **Not exported**: Rho has no vendor endpoint; scheduled payments are the closest thing.

## Still to confirm against a live account

The specs don't settle these. Each one fails safe: a 400 marks the resource failed, and the rest of
the run continues.

- Brex: whether `/v2/cards` without `user_id` returns every card for an admin token.
- Brex: whether every list accepts `limit=100`.
- Mercury: whether every list endpoint accepts `limit` (the spec documents it on most, not all).
- Rho: actual token prefix format, which would let the UI's wrong-platform hint cover Rho too.
