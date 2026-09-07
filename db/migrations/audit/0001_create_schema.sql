-- not-tenant-owned: the schema statement creates no table.
-- Module: audit. Append-only; the lint refuses UPDATE, DELETE, TRUNCATE and
-- DROP against this schema, and a column drop or type change on its tables.
-- The audit record itself is epic P0.10 and is NOT created here.
CREATE SCHEMA IF NOT EXISTS audit;
