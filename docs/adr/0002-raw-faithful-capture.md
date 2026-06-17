# 0002 — Exporter does raw-faithful capture; all normalization lives in our SaaS

**Status:** accepted

The exporter writes files that mirror Ramp's API shapes as closely as possible (JSONL,
nested objects preserved) and has **zero knowledge** of our platform's data model. Every
translation toward our model — field mapping, value mapping (Ramp role → our role), and any
aggregation (e.g. per-vendor spend rollups) — happens on the SaaS side as "Mappings." The
exporter is deliberately dumb.

**Why it's recorded:** the obvious instinct is to make the exporter emit data already shaped
like our product, to save ingestion work. We rejected that: it would publish our data model
in a public repo, weld the two sides together (a model change would force every customer to
re-run a new exporter), and break the principle that "Ramp is just one export format."

## Consequences
- Ingestion does more work (parse raw Ramp shapes, then map) — by design; that's our private side.
- Output is JSONL, not CSV: CSV would force flattening of Ramp's nested objects, which is itself
  a transformation and loses data. Faithful capture ⇒ JSONL.
- Narrow, pragmatic exception worth noting: where Ramp exposes no usable primitive (e.g. it has
  no native per-vendor spend total), the exporter still only captures raw ledger metadata; the
  derived rollup is computed in the SaaS, preserving this boundary.
