-- Round four finding I5: `ALTER FOREIGN TABLE audit.evidence ALTER COLUMN
-- amount TYPE numeric;` PASSED while the identical change written
-- `ALTER TABLE` was refused. M3 now recognises the same relation types
-- RENAMEABLE_TYPES already names for the rest of this file.
ALTER FOREIGN TABLE audit.evidence ALTER COLUMN amount TYPE numeric;
