-- A function body written as a single-quoted string literal is as unreadable
-- to this lint as a dollar-quoted one - scrub() blanks both - but only the
-- $$ form was refused.
CREATE FUNCTION tenancy.compute() RETURNS int AS 'SELECT 1' LANGUAGE sql;
