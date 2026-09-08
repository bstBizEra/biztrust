-- Round four finding I3: a column typed with another module's type. This
-- passed M1 entirely; the same line written `audit.status_code(10)` was
-- caught only by accident, as an EXPR CALL.
CREATE TABLE tenancy.evidence_note (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  code audit.status_code NOT NULL
);
