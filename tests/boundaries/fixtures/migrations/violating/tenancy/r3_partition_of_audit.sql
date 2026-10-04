-- Round three open finding 9, second half: a partition structurally couples
-- this table's own definition to the parent named in PARTITION OF - tighter
-- than a foreign key, since every column, constraint and index of the
-- parent is inherited, not merely referenced.
--
-- not-tenant-owned: PARTITION OF syntax carries no column list of its own -
-- every column is inherited from the parent - so there is nowhere in this
-- statement's own text to put a tenant_id, and this marker keeps that a
-- known, declared gap rather than a second, accidental violation shape.
CREATE TABLE tenancy.decision_2024 PARTITION OF audit.decision
    FOR VALUES FROM ('2024-01-01') TO ('2025-01-01');
