-- COMMENT ON names an object in a schema, exactly the shape M1 exists to
-- check, but this lint does not resolve which schema that object belongs to.
-- Rather than guess, it is refused like any other unmodelled statement.
COMMENT ON SCHEMA audit IS 'left here by a migration this module does not own';
