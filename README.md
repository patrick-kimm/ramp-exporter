# ramp-exporter

> A small, open-source CLI a Ramp **customer** runs themselves to export their own data
> into neutral files. Their own credentials, their own machine, files they control.

`ramp-exporter` reads a slice of a Ramp account — **users, cards, and vendors** — using the
customer's *own* Ramp developer credentials, and writes it to a local **export bundle**
(JSONL files + a manifest). A separate, proprietary product (the "Migration Cockpit") later
ingests that bundle. This tool never talks to anything but Ramp, never phones home, and
writes only to a folder you choose. Because it's open source, your security team can read
every line that touches your credentials.

> ⚠️ Not affiliated with, endorsed by, or sponsored by Ramp Business Corporation. "Ramp" is
> used only to describe the data source this tool reads, using your own developer credentials,
> under Ramp's API terms. See [ADR-0001](docs/adr/0001-customer-run-firewall.md).

## Scope (v1)

Faithful capture only — this tool mirrors Ramp's API shapes and does **no** transformation.
All normalization happens downstream in the Cockpit. See
[ADR-0002](docs/adr/0002-raw-faithful-capture.md).

| Category | What it exports (raw Ramp objects, JSONL) |
|----------|--------------------------------------------|
| **Users**   | users, departments, locations (role, manager links) |
| **Cards**   | cards, spend limits, spend programs |
| **Vendors** | vendors, plus bills/transactions **metadata** (to derive spend per vendor downstream) |

**Explicitly out of v1:** receipt/document binaries, incremental sync, cloud-storage upload,
mapping/normalization, multi-provider. Each run is a full snapshot.

## How it's run (v1)

v1 is **assisted**: a solutions engineer drives it on a screen-share while the *customer*
runs it on the *customer's* machine with the *customer's* credentials. (Self-serve Docker /
wizard UX is v2.)

```bash
# 1. Customer admin creates a read-only developer app in Ramp:
#    Settings → Developer → new app → Client Credentials grant → resource:read scopes
# 2. Configure
cp config.example.yml config.yml      # choose categories, date range, output folder
cp .env.example .env                   # paste RAMP_CLIENT_ID / RAMP_CLIENT_SECRET

# 3. Preview (counts only, writes nothing)
ramp-exporter plan --config config.yml

# 4. Export (Users first — the v1 tracer slice)
ramp-exporter export users --config config.yml
# later slices:  export cards   |   export vendors   |   export all

# 5. Verify the bundle is complete and well-formed
ramp-exporter validate ./exports/ramp/<run_id>

# 6. Zip ./exports/ramp/<run_id> and upload it to the Migration Cockpit.
```

## Output

```
exports/ramp/2026-06-17T12-30-00Z__a1b2c3/
├── export-metadata.json     # manifest: versions, counts, sha256 per file (the contract)
├── users.jsonl
├── departments.jsonl
├── locations.jsonl
├── cards.jsonl              # (cards slice)
├── spend_limits.jsonl
├── spend_programs.jsonl
├── vendors.jsonl           # (vendors slice)
├── bills.jsonl             # ledger METADATA only — no receipt binaries
├── transactions.jsonl
└── _SUCCESS                 # written last, atomically — signals "bundle complete"
```

See [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) for the bundle contract.

## Design docs

- [CONTEXT.md](CONTEXT.md) — shared domain language + every locked decision
- [docs/EXPORT_FORMAT.md](docs/EXPORT_FORMAT.md) — bundle layout + manifest contract
- [docs/adr/](docs/adr/) — the two load-bearing architecture decisions

## License

Apache-2.0 — adoption and auditability are the point.
