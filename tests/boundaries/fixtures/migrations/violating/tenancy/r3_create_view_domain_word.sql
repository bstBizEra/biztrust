-- A view is queryable exactly like a table and is included in
-- TABLE_CREATING_VERBS for that reason; M4 must fire on it, not just on
-- CREATE TABLE. tenant_id is selected so this fixture proves ONLY the M4
-- shape and does not also trip M5.
CREATE VIEW tenancy.policy AS SELECT id, tenant_id FROM tenancy.orphan;
