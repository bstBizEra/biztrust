-- Round five ruling: TYPE_POSITIONS is one alternation of five declaration
-- positions and only two of them had a fixture, so deleting entry 3, 4 or 5
-- left the whole suite green. This is the third position, ALTER ... TYPE,
-- carrying that one violation shape and no other.
ALTER TABLE tenancy.evidence_note ALTER COLUMN code TYPE audit.status_code;
