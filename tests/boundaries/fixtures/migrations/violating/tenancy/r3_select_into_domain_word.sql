-- Added by ruling on review of this task: SELECT ... INTO creates a table
-- exactly as CREATE TABLE does, and was left out of TABLE_CREATING_VERBS.
-- tenant_id is selected so this fixture proves ONLY the M4 shape.
SELECT id, tenant_id INTO tenancy.policy FROM tenancy.orphan;
