-- Round four finding I5, the other spelling the literal `ALTER TABLE` anchor
-- missed. The lint refuses the SHAPE, whether or not a given server would
-- accept this particular statement: a shape it cannot prove safe is a
-- refusal here, not a silence.
ALTER MATERIALIZED VIEW audit.evidence_mv ALTER COLUMN amount TYPE numeric;
