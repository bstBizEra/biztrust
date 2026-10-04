-- Round five, the attribution round: a column ADDED with another module's
-- type. Round four finding I3 built TYPE_POSITIONS as one alternation of
-- five declaration positions and gave only the first of them - a relation's
-- own column list - a fixture, so the mutation that removes the WHOLE scan
-- and the mutation that removes only that one entry were caught by the same
-- control and neither proved anything the other did not. This is the second
-- position, ADD COLUMN, carrying that one violation shape and no other.
ALTER TABLE tenancy.evidence_note ADD COLUMN reviewed_code audit.status_code;
