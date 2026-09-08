-- The JOIN half of the same finding: reading another module's schema by
-- joining into it is exactly as much a read as selecting FROM it directly.
-- The base FROM here is this module's own schema and so is not itself a
-- violation; only the JOIN crosses the boundary. tenant_id is present so
-- this fixture proves ONLY the JOIN shape, not M5.
CREATE TABLE tenancy.decision_join AS
SELECT le.tenant_id, d.decision_id
FROM tenancy.legal_entity le
JOIN audit.decision d ON d.tenant_id = le.tenant_id;
