-- Round four finding I4, second half: `PARTITION OF` was closed in CREATE
-- position only. `ATTACH PARTITION` makes the identical structural coupling
-- afterwards, and is not the string `PARTITION OF`.
ALTER TABLE tenancy.notes ATTACH PARTITION audit.shard FOR VALUES IN (1);
