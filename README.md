# ramp-exporter

> Customer-run, open-source export for your Ramp data. **Your credentials, your machine, files you control.**

`ramp-exporter` pulls your **users, cards, and vendors** out of Ramp — using *your own* Ramp
developer credentials — into neutral, portable files (JSONL + a manifest). It runs entirely on
your machine, via a one-command **local web UI** or a CLI. It never phones home: your Ramp
credentials are held in memory and sent only to Ramp, and the data is written only to a folder
you choose. Because it's open source, your security team can read every line that touches your
credentials.

> ⚠️ Not affiliated with, endorsed by, or sponsored by Ramp Business Corporation. "Ramp" is used
> only to describe the data source this tool reads, using your own developer credentials, under
> Ramp's API terms.

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone git@github.com:patrick-kimm/ramp-exporter.git
cd ramp-exporter
bun install
```

Create a **read-only** Ramp developer app — Ramp dashboard → **Settings → Developer** → new app →
grant type **Client credentials** — and enable **all ten** of these read scopes (Ramp rejects the
token request with a 403 if any one is missing):

```
users:read  departments:read  locations:read  entities:read
cards:read  spend_programs:read  funds:read
vendors:read  bills:read  transactions:read
```

Copy the **Client ID** and **Client Secret**.

### Option A — the local UI (recommended)

```bash
bun run src/cli.ts ui        # serves http://localhost:4747 and opens your browser
```

Paste your Client ID + Secret, pick categories, hit **Run export →**. Bills and transactions
export your full history unless you set a date window under **advanced**. Your data appears in a tab
per resource, and the same files are written to `./exports`. Credentials never leave your machine.

### Option B — the CLI

```bash
cp config.example.yml config.yml     # choose categories, date range, output folder
cp .env.example .env                  # paste RAMP_CLIENT_ID / RAMP_CLIENT_SECRET
bun run src/cli.ts export all --config config.yml
bun run src/cli.ts validate ./exports/ramp/<run_id>
```

## What it exports

| Category | Resources (raw Ramp objects, JSONL) |
|----------|-------------------------------------|
| **Users**   | users, departments, locations |
| **Cards**   | cards, spend limits, spend programs |
| **Vendors** | vendors, plus bills/transactions (date-bounded) |

Faithful capture only — files mirror Ramp's API shapes, with no transformation. Card numbers and
vendor bank accounts arrive **masked** (Ramp only exposes last-4); full PANs are never requested.

## Output bundle

```
exports/ramp/<run_id>/
├── export-metadata.json    # manifest: versions, counts, sha256 per file
├── users.jsonl
├── cards.jsonl
├── vendors.jsonl
├── …
└── _SUCCESS                 # written last — signals the bundle is complete
```

The manifest is the contract any downstream system can rely on — see
[`docs/export-metadata.schema.json`](docs/export-metadata.schema.json).

## How it stays safe

- Ramp credentials are used **in memory only** — never written to disk by the tool, never logged,
  never sent anywhere but Ramp.
- Output is written to local storage you control.
- Open source and auditable end to end.

Design rationale lives in [`CONTEXT.md`](CONTEXT.md) and the [ADRs](docs/adr/); the verified Ramp
API facts (auth, pagination, scopes, masking) are in [`docs/ramp-api-notes.md`](docs/ramp-api-notes.md).

## Development

```bash
bun test          # hermetic — no network, no real credentials
bun run typecheck
```

## License

[Apache-2.0](LICENSE).
