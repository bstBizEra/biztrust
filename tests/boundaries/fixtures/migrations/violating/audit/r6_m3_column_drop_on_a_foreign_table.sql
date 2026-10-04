-- Round four finding I5: M3's column-drop sub-check was anchored to the
-- literal keywords `ALTER TABLE`, so the same drop on a foreign table did
-- not reach it.
ALTER FOREIGN TABLE audit.evidence DROP COLUMN authority_reference;
