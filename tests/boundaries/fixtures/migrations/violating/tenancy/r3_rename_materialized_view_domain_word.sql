-- Completing coverage of the RENAME TO alternation's fourth form: a
-- materialized view rename must also be caught by M4.
CREATE MATERIALIZED VIEW tenancy.neutral4 AS SELECT id, tenant_id FROM tenancy.orphan;

ALTER MATERIALIZED VIEW tenancy.neutral4 RENAME TO premium;
