-- Round three open finding 9: `CREATE TABLE ... AS SELECT ... FROM
-- audit.x` reads every row of another module's schema, exactly what
-- AGENTS.md section 5 forbids, and objectTargets never looked at a FROM
-- clause at all - only what a statement CREATES, ALTERS or DROPS. The
-- selected columns include tenant_id so this fixture proves ONLY the FROM
-- shape, not M5.
CREATE TABLE tenancy.decision_mirror AS
SELECT tenant_id, decision_id FROM audit.decision;
