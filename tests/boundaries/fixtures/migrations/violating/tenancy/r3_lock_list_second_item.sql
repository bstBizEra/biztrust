-- LOCK accepts a comma-separated table list. A single-anchor regex reads
-- only the FIRST name and never looks at the rest, so a same-schema table
-- listed first let a cross-schema table listed after it lint clean.
LOCK TABLE tenancy.safe_table, audit.decision;
