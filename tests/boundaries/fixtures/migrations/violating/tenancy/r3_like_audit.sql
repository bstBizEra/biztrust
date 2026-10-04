-- The LIKE form of the same structural coupling: `LIKE audit.decision`
-- inside a column list copies that table's column definitions into this
-- one at creation time. tenant_id is given its own explicit column here so
-- this fixture proves ONLY the LIKE shape, not M5.
CREATE TABLE tenancy.decision_like (
    tenant_id uuid NOT NULL,
    LIKE audit.decision INCLUDING ALL
);
