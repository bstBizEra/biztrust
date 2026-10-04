-- Round three open finding 9, third form: INHERITS structurally couples
-- this table to the parent named in parentheses after it, the same
-- structural coupling PARTITION OF creates. tenant_id is given its own
-- explicit column here so this fixture proves ONLY the INHERITS shape, not
-- M5.
CREATE TABLE tenancy.decision_extension (
    tenant_id uuid NOT NULL,
    note text
) INHERITS (audit.decision);
