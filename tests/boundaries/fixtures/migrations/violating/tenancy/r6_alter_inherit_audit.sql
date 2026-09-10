-- Round four finding I4, first half: INHERITS was closed in CREATE position
-- only. `INHERIT` (singular) makes the identical structural coupling
-- afterwards, and is a different keyword the literal `INHERITS` entry never
-- matched.
ALTER TABLE tenancy.notes INHERIT audit.evidence;
