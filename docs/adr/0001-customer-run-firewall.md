# 0001 — Customer-run exporter; our SaaS ingests files only

**Status:** accepted

The exporter is an open-source tool the **Customer** runs themselves, authenticating to
Ramp with *their own* developer credentials and writing files to storage *they* control.
Our SaaS only ever ingests those files; our backend never calls Ramp's API and never holds
Ramp OAuth secrets. This is a deliberate legal/compliance firewall, not a convenience —
direct integration would be smoother UX but would put us in the position of calling another
vendor's API on customers' behalf and holding their secrets, which we will not do.

**Why it's recorded:** a future engineer will see the awkward file-handoff seam and be
tempted to "just call Ramp directly from the backend." That temptation is the thing this
firewall exists to forbid. The boundary is the product's legal posture.

## Consequences
- The exporter MUST be genuinely public and auditable (customers/security teams read the
  code that touches their creds) — even though intent is otherwise a lean, tactical tool.
- The file contract (bundle layout + `export-metadata.json` manifest) is the *only* coupling
  between the two sides; both evolve independently behind it.
- "Assisted" operation means our SE helps the Customer run it **customer-side** (their machine,
  their creds, their storage). Running it on our infra with their creds breaches the firewall.
