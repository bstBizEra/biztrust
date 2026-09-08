-- Round three review of Task 2's first pass: the RENAME TO scan recognised
-- only the literal keyword TABLE, so ALTER VIEW ... RENAME TO walked past
-- M4 even though CREATE VIEW is in TABLE_CREATING_VERBS. tenant_id is
-- selected by the original view so this fixture proves ONLY the M4 shape.
CREATE VIEW tenancy.neutral2 AS SELECT id, tenant_id FROM tenancy.orphan;

ALTER VIEW tenancy.neutral2 RENAME TO policy;
