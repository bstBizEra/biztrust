-- Finding 2 (round three re-review of the EXPR CALL scan): the
-- CREATE/ALTER/DROP scan already resolves this statement's target from the
-- relation's own name; the EXPR CALL scan must not ALSO read
-- `tenancy.definition_ok (` as a schema-qualified function call just
-- because the table being DEFINED is immediately followed by its own
-- column list. The report on this task verified this exact shape
-- double-reporting M1 before the fix.
CREATE TABLE tenancy.definition_ok (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY
);
