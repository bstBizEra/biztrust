-- MERGE INTO writes rows into another module's schema, the same act
-- INSERT INTO is already modelled for. Checkpoint declared_non_coverage item 7.
MERGE INTO audit.decision AS d
USING tenancy.staged_decision AS s
ON d.decision_id = s.decision_id
WHEN NOT MATCHED THEN INSERT (decision_id) VALUES (s.decision_id);
