-- Review finding on this task: a schema-qualified function call inside a
-- column DEFAULT is structural coupling of exactly the kind AGENTS.md
-- section 5 forbids - it runs on every insert - and no clause-introducing
-- keyword precedes it the way FROM or JOIN does, so nothing before this fix
-- ever looked inside a DEFAULT expression at all.
CREATE TABLE tenancy.probe_default (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY DEFAULT audit.gen_uuid()
);
