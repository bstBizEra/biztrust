-- Round three open finding 8: M4 gated on `target.verb !== "CREATE TABLE"`,
-- one literal string, so a foreign table walked past it. A foreign table is
-- exactly as able to be a P0 domain table as a plain one is; tenant_id is
-- present so this fixture proves ONLY the M4 shape, not M5.
CREATE FOREIGN TABLE tenancy.claim (
    id uuid,
    tenant_id uuid
) SERVER loopback_srv OPTIONS (table_name 'claim');
