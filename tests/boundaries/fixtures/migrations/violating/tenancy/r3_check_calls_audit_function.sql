-- Same finding, the CHECK form: this runs on every insert AND update, so it
-- is at least as tight a coupling as the DEFAULT form. tenant_id is present
-- so this fixture proves ONLY the expression-position call shape, not M5.
CREATE TABLE tenancy.probe_check (
  tenant_id uuid NOT NULL,
  code text CHECK (audit.is_valid_code(code))
);
