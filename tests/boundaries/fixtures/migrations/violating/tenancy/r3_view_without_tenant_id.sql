-- M5 decision for this task: a view is NOT exempt from the tenant_id
-- requirement. It has no columns of its own to add tenant_id to, but it is
-- still a queryable relation that can re-expose every row of a tenant-owned
-- table to a caller who never checked tenant_id - the exact harm M5 exists
-- to prevent. "summary" is not a domain word, so this fixture proves ONLY
-- the M5 shape and does not also trip M4.
CREATE VIEW tenancy.summary AS SELECT id FROM tenancy.orphan;
