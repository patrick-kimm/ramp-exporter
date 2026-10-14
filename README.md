# ramp-exporter

> Customer-run, open-source export for your **Ramp, Mercury, Brex, or Rho** data. **Your credentials, your machine, files you control.**

`ramp-exporter` pulls your team, cards, accounts, transactions, vendors, and expenses out of the
platform you're leaving, using *your own* API credentials, into neutral, portable files (JSONL
plus a manifest). It runs entirely on your machine, through a one-command **local web UI** or a
CLI. It never phones home: credentials are held in memory and sent only to the platform they belong
to, and data is written only to a folder you choose. Because it's open source, your security team
can read every line that touches your credentials.

> ⚠️ Not affiliated with, endorsed by, or sponsored by Ramp, Mercury, Brex, or Rho. Their names are
> used only to describe the data sources this tool reads, using your own credentials, under each
> platform's API terms.

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone git@github.com:patrick-kimm/ramp-exporter.git
cd ramp-exporter
bun install
bun run src/cli.ts ui        # serves http://localhost:4747 and opens your browser
```

Pick the platform you're moving from, paste a read-only credential, choose what to export, and run it.
Before anything is exported, the UI checks what the credential can read, and anything it can't is
named up front and skipped. Results show up in a tab per category, and the files are written to
`./exports/<platform>/<run_id>`.

### Getting a read-only credential

| Platform | Where | What to paste |
|----------|-------|---------------|
| **Ramp** | Settings → Developer → Create app, **Client credentials** grant, all ten read scopes | Client ID + Client Secret |
| **Mercury** | Settings → API Tokens → **Read Only** (no IP allowlist needed) | API token (`secret-token:…`; the prefix is optional) |
| **Brex** | Settings → Developer → Create token, **Read** on every data type (account admin) | User token (`bxt_…`) |
| **Rho** | Settings → Configurations → Access Tokens, every read scope (owner or admin) | API access token |

Ramp rejects the token request if any one of its ten scopes is missing:
`users:read departments:read locations:read entities:read cards:read spend_programs:read funds:read vendors:read bills:read transactions:read`.
The other platforms check permissions per resource, so a missing one only skips that resource.

### The CLI

```bash
cp .env.example .env                  # fill in the lines for your platform
bun run src/cli.ts sources            # categories and env vars for each platform
bun run src/cli.ts export --source mercury                 # everything
bun run src/cli.ts export accounts cards --source brex     # just these categories
bun run src/cli.ts validate ./exports/brex/<run_id>
```

`config.yml` (see [`config.example.yml`](config.example.yml)) is optional. Use it to pin a platform,
categories, a history window, or an output folder.

## What it exports

| Platform | Categories |
|----------|------------|
| **Ramp** | users (users, departments, locations, entities) · cards (cards, spend programs, funds) · vendors (vendors, vendor contacts, bills, card transactions) |
| **Mercury** | team (organization, users) · accounts & transactions (bank, credit, treasury accounts, statements, transactions, custom categories) · cards · recipients · invoicing (customers, invoices) |
| **Brex** | team (company, users, departments, locations, titles, cost centers, legal entities) · cards (cards, budgets, spend limits, budget programs) · accounts & transactions (card and cash accounts, statements, transactions, linked banks) · vendors & payments · expenses (with memos, categories, custom fields) |
| **Rho** | team (business, users, removed users) · accounts & transactions (accounts, credit programs, statements, transactions) · cards · scheduled payments · expenses (expenses, reimbursements, custom fields) · invoicing |

Capture is faithful, with no transformation: files mirror each platform's API shapes. A history
window bounds only the ledgers (transactions, bills, expenses); everything else is exported in full.

**Sensitive data:** Ramp masks card and bank numbers at the source. Mercury (accounts, statements,
recipients) and Brex (cash accounts, vendors) return **full** account and routing numbers. Those are
exported verbatim, masked on screen, and flagged on the review page, so keep the folder private.
No platform's card PANs are ever requested.

## Output bundle

```
exports/<platform>/<run_id>/
├── export-metadata.json    # manifest: platform, versions, counts, sha256 per file, anything skipped and why
├── users.jsonl
├── transactions.jsonl
├── …
└── _SUCCESS                 # written last — signals the bundle is complete
```

When a resource can't be read, the manifest records it as `skipped` or `failed`, with a reason and
the permission it needed, and the run's status becomes `partial`. A run where nothing can be read
writes no bundle. The manifest is the contract any downstream system can rely on; see
[`docs/export-metadata.schema.json`](docs/export-metadata.schema.json).

## How it stays safe

- Credentials are used **in memory only**: never written to disk by the tool, never logged, and
  never sent anywhere but the platform they belong to. Error messages redact them.
- Every request is a read (`GET`), apart from Ramp's token exchange.
- Output is written to local storage you control. A cancelled or failed export is deleted.
- Open source and auditable end to end.

Design rationale lives in [`CONTEXT.md`](CONTEXT.md) and the [ADRs](docs/adr/). The verified API
facts (auth, pagination, date semantics, masking) are in [`docs/ramp-api-notes.md`](docs/ramp-api-notes.md)
and [`docs/provider-api-notes.md`](docs/provider-api-notes.md).

## Development

```bash
bun test                     # hermetic: no network, no real credentials
bun run typecheck
bun run scripts/demo.ts      # the UI against local fake APIs for all four platforms
```

Each platform is one declarative file in [`src/sources/`](src/sources/): auth, pagination style,
resources, categories, and setup copy. The shared client, export loop, and UI read everything else
from it.

## License

[Apache-2.0](LICENSE).
