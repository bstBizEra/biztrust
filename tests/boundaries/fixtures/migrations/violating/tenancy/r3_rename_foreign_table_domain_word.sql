-- Same defect, the second reproduction from review: ALTER FOREIGN TABLE ...
-- RENAME TO also walked past M4, because the RENAME TO scan recognised only
-- the literal keyword TABLE. tenant_id is present on the original foreign
-- table so this fixture proves ONLY the M4 shape.
CREATE FOREIGN TABLE tenancy.neutral3 (
    id uuid,
    tenant_id uuid
) SERVER loopback_srv OPTIONS (table_name 'neutral3');

ALTER FOREIGN TABLE tenancy.neutral3 RENAME TO claim;
