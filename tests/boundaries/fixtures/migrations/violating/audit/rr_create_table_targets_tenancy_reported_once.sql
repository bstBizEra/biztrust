-- Finding 2 (round three re-review of the EXPR CALL scan): before the scan
-- excluded a relation's own column list from the "call" shape, this exact
-- statement was reported for M1 TWICE - once by the CREATE/ALTER/DROP scan
-- that resolves this statement's real target, and once more by the EXPR
-- CALL scan mistaking `tenancy.definition_ok (` for a schema-qualified
-- function call. Placed under audit/ so the cross-schema violation is
-- real (this directory owns "audit", the table names "tenancy"), and the
-- control for this fixture asserts an EXACT count of one line, not merely
-- "at least one" - "at least one" is satisfied whether or not the
-- duplicate comes back, and would not catch its return.
CREATE TABLE tenancy.definition_ok (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY
);
