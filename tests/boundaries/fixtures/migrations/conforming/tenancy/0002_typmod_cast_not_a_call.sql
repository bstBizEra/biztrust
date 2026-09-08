-- Finding 1 (round three re-review of the EXPR CALL scan): a schema-
-- qualified TYPE CAST carrying a precision/scale/length modifier reads as
-- exactly the same shape the EXPR CALL scan looks for -
-- `(schema).(name)` immediately followed by `(` - as a schema-qualified
-- function CALL does. All three casts below are ordinary, legal PostgreSQL
-- (casting to pg_catalog's own built-in types, with a typmod argument
-- list) and must not be reported as touching schema "pg_catalog".
CREATE TABLE tenancy.cast_typmod_ok (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  amount_col numeric NOT NULL DEFAULT '0'::pg_catalog.numeric(10,2),
  code_col varchar NOT NULL DEFAULT 'x'::pg_catalog.varchar(255),
  flags_col bit(8) NOT NULL DEFAULT b'1'::pg_catalog.bit(8)
);
