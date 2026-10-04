-- Added by ruling on review of this task: SELECT ... INTO creates a table
-- exactly as CREATE TABLE does, and must carry tenant_id too. "aggregate" is
-- not a domain word, so this fixture proves ONLY the M5 shape.
SELECT id INTO tenancy.aggregate FROM tenancy.orphan;
