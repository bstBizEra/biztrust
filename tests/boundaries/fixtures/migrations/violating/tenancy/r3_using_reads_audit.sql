-- The DELETE ... USING form of the same read: USING here names a second
-- table the DELETE reads to decide which rows to remove, not a JOIN ...
-- USING (columns) list, so it is a table reference this scan must resolve.
-- The target being deleted from is this module's own schema, so only the
-- USING clause crosses the boundary.
DELETE FROM tenancy.stale_mirror USING audit.decision
WHERE tenancy.stale_mirror.decision_id = audit.decision.decision_id;
