-- Round five ruling: the fourth TYPE_POSITIONS entry, a function's RETURNS
-- clause. Written with a bare RETURN expression rather than a body, so the
-- fixture carries this one shape and not the separate refusal of a function
-- body this lint cannot read.
CREATE FUNCTION tenancy.grade_note() RETURNS audit.status_code LANGUAGE sql RETURN 1;
