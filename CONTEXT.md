# Ramp Exporter — Context

A customer-run, open-source tool that exports a slice of a **Customer's** Ramp account
into neutral files in storage the Customer controls. A separate proprietary SaaS (the
"Migration Cockpit") later ingests those files. This doc is the shared domain language
for both sides.

**Intent (working):** _tactical deal-unblocker_ — exists to kill the "we're locked into
Ramp" objection in competitive deals. Ramp-only, lean. (Candidate ADR — not yet locked.)

## Language

### Actors
**Customer**:
The business migrating off Ramp; the org that runs the exporter and buys our platform.
_Avoid_: account, client, tenant, user.

**User**:
An employee of the **Customer** — a cardholder / spender / approver inside their Ramp org.
_Avoid_: customer, member.

**Vendor**:
A party the **Customer** pays (supplier/payee). Not a User, not the Customer.
_Avoid_: merchant, supplier, payee (use Vendor).

### Export scope — the four categories
The exporter captures four slices of the Customer's Ramp account:

**Users category**:
Identity + org structure for each **User**: full name, email, **Role**, **Manager**, plus
the **Department** and **Location** they belong to.

**Cards category**:
The spend-control configuration: which **Cards** exist, each **Card**→**User** binding, and
each Card's **Limit**, **Policy**, **Spend Program**, and "funds" (term unresolved — see
Flagged ambiguities).

**Vendors category**:
The payment relationships: who the Customer pays, how much, over what **Payment Rail**
(ACH/wire/card), plus per-Vendor metadata Ramp exposes (invoices/receipts — tentative).

**Mappings category** _(deferred — "cross that bridge later")_:
Translation of Ramp reference values into the Customer's / our accounting model. Named now
so it isn't lost; scope TBD.

### Supporting terms
**Department**: An org unit a **User** belongs to (reference entity, not a free-text field).
**Location**: A physical/legal site a **User** belongs to (reference entity).
**Role**: A User's permission level in Ramp (e.g. Admin/Bookkeeper/Cardholder). Mapping Ramp
roles → our roles is a **Mappings** concern.
**Manager**: The **User** another User reports to (forms the approval chain).
**Card**: A physical or virtual spend instrument issued to a **User**. (Distinct Ramp object.)
**Spend Limit** (a.k.a. _Limit_): Ramp's core spending construct — the restriction a **Card**
spends against (amount, interval, allowed/blocked categories & merchants, receipt/memo rules).
(Distinct Ramp object.) A Spend Limit may reference a **Spend Program** id, or stand alone.
**Spend Program**: A grouping/template that applies shared policy to a set of Spend Limits/Cards.
(Distinct Ramp object.)
_Note_: Ramp has **no separate "Policy" object** — restrictions/policy are fields on Spend Limit /
Spend Program. We will not model Policy as its own entity. "Funds"/available balance, if present,
is just a field on the Spend Limit and is captured verbatim under raw-faithful (no need to pre-define).
**Payment Rail**: The mechanism a **Payment** moves over — ACH, wire, or card.
**Export Bundle**: The output of one exporter run — a directory of files + a Manifest.
**Manifest**: `export-metadata.json` at the bundle root; the versioned compatibility contract.

## Relationships
- A **Customer** has many **Users**.
- A **User** belongs to one **Department** and one **Location**, has a **Role**, and reports to a **Manager** (another User).
- A **User** holds zero or more **Cards**.
- A **Card** is governed by a **Limit** and a **Policy**, possibly via a **Spend Program**.
- A **Customer** pays many **Vendors**; each payment moves over a **Payment Rail**.
- An **Export Bundle** is one run; a **Manifest** describes it.

## Flagged ambiguities
- **"funds"** (Cards category) — RESOLVED: not a special concept; whatever balance field exists on a Spend Limit is captured verbatim under raw-faithful. (Verify exact field name in Ramp OpenAPI before schema lock.)
- **Policy vs Spend Program** — RESOLVED: distinct Ramp objects (Card / Spend Limit / Spend Program). "Policy" is fields, not an entity. (See Language.)
- **Vendor payment-history granularity** — RESOLVED (intent): per-**Vendor** rollup for v1; per-payment ledger deferred to v2. BUT see reality conflict below.
- **Rollup feasibility** — RESOLVED: exporter pages bills/transactions **metadata** (no receipt binaries) and writes them raw-faithfully; the **SaaS computes** per-Vendor totals + rails (rail = `payment_method` ∈ ACH/CARD/CHECK/WIRE, on the payment). Ramp exposes no native vendor totals, so the ledger pull is unavoidable — but skipping receipt binaries dodges the document explosion.
- **Documents/receipts** — OUT of v1. No binary downloads. (The "tentative" vendor metadata from the original scope is deferred with the v2 ledger/receipts work.)
- **Mappings** — what maps to what (GL/COA? our model? Ramp roles → our roles?) → deferred.

## Resolved decisions
- **Intent**: tactical deal-unblocker (Ramp-only, lean), with a floor of "real, public, auditable OSS repo" because the legal firewall depends on it. → ADR-0001.
- **Firewall / boundary**: customer runs the exporter with their own creds; our SaaS only ever ingests files; backend never calls Ramp / never holds Ramp secrets. → ADR-0001.
- **Schema fidelity**: raw-faithful capture — exporter mirrors Ramp shapes, all normalization lives in our SaaS as Mappings. → ADR-0002.
- **Output format**: JSONL per resource (Ramp objects are nested; CSV would force lossy flattening). Vendor rollup CSV is a SaaS-side derived view, not an exporter output.
- **Run cadence**: repeatable full snapshots; no incremental/watermarks/dedup; within-run resumability only.
- **Operator model (v1)**: assisted, CLI-first — your SE drives it customer-side; defer self-serve/Docker/wizard polish.
- **Air-gap handoff (v1)**: exporter writes a local folder → SE/customer uploads ZIP to the Cockpit. Cloud-bucket auto-discovery + SFTP deferred to v2.
- **Cockpit scope (v1)**: ingest + validate → staging → "here's what we found" confidence report (incl. SaaS-computed vendor rollup). Read-only; no mapping, no commit to core models.
- **Build order**: Users (engineering tracer) → Cards (product wow) → Vendors (ledger + aggregation).
- **Exporter stack**: TypeScript on **Bun**. Chosen over Go because v1 is assisted (no single-binary need yet), solo-maintainer fluency, and one language across exporter + Cockpit (assumed TS) — lets the two repos share the manifest *contract* types + schema validation (not customer data — the firewall holds). Bun's standalone-binary compile covers the v2 self-serve distribution story when we get there.
- **Auth feasibility (CONFIRMED)**: a Customer admin self-serves a developer app under Settings→Developer; OAuth2 client-credentials; `resource:read` scopes; no partner gate for production read of own data (sandbox access needs an account manager).

## Out of v1 scope (explicit no's — all v2+)
Receipts/document binaries · per-payment ledger as a product surface (we capture metadata, don't expose it) · Mappings / normalization · commit into core models · vendor bank-detail re-collection · incremental/sync · cloud-bucket auto-discovery · SFTP · self-serve/Docker/finance-friendly UX · multi-provider (Brex/Bill/Airbase).

## Doc status
- `README.md`, `config.example.yml`, `docs/export-metadata.schema.json`, `.env.example` — REALIGNED to the decisions above (JSONL, full-snapshot, Ramp-only, no documents). Empty pre-grill scaffold dirs removed.
- **Not yet scaffolded** (awaiting a separate scaffold pass): CLI structure, JSONL bundle writer, manifest emitter, Cockpit ingest/summary shape. Build order: Users → Cards → Vendors.

## Open verification (before schema lock — non-blocking)
- Exact Ramp **scope slugs** (e.g. is it `limits:read` / `spend_programs:read`?) — verify against Ramp's scopes page.
- Exact field names for **vendor bank-detail masking** and the **Spend Limit balance/"funds"** field — verify against Ramp's OpenAPI spec.
