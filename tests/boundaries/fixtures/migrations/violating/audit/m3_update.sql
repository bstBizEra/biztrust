-- M3: UPDATE on the audit schema. Named in AGENTS.md section 5, witnessed by
-- nothing until the coverage gate asked.
UPDATE audit.decision SET authority_reference = 'x' WHERE id = 'y';
