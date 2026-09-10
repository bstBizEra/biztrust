-- not-tenant-owned: the schema statement creates no table.
-- Module: tenancy. Owns schema "tenancy" and no other (P0.2, one schema per module).
-- The tables of this schema are epic P0.6 and are NOT created here.
CREATE SCHEMA IF NOT EXISTS tenancy;
