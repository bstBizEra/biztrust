-- Round three open finding 10, first half: `REFERENCES othertable` with no
-- column list at all - perfectly legal PostgreSQL, meaning "the referenced
-- table's primary key" - escaped M2's unqualified branch, which required a
-- trailing "(" immediately after the referenced name. ml3_unqualified_fk.sql
-- always writes the column list, so this shape needs its own fixture.
CREATE TABLE tenancy.unqualified_fk_no_columns (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  other uuid REFERENCES tenant
);
