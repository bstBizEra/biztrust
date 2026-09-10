-- Negative control 12, third form: a column type change on the audit schema.
ALTER TABLE audit.decision ALTER COLUMN authority_reference TYPE text;
