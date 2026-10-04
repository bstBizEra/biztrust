-- Finding 3 (DEC-016's case-folding defect, pulled into this round by
-- ruling): PostgreSQL folds every UNQUOTED identifier to lower case, so an
-- unquoted schema name written in a different case than the registry's own
-- still names this directory's own schema "tenancy". Before the
-- case-folding fix in scrub(), each differently-cased form below - the bare
-- schema name and the schema-qualified table name - was compared literally
-- against "tenancy" and reported as touching a foreign schema, even though
-- this directory owns the schema it names.
CREATE SCHEMA IF NOT EXISTS TENANCY;
CREATE TABLE Tenancy.mixed_case_ok (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY
);
