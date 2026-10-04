-- Round four finding I2. `understood` was `targets.length > 0`, and the EXPR
-- CALL scan pushes a target from any `schema.name(` anywhere in a statement,
-- so an unmodelled statement that merely CONTAINED an own-schema call shape
-- stopped being refused. `COMMENT ON TABLE tenancy.thing IS '...'` was
-- refused; this - and `GRANT EXECUTE ON FUNCTION tenancy.f(uuid) TO PUBLIC`,
-- and `SECURITY LABEL FOR provider ON FUNCTION tenancy.f(uuid) IS 'x'` -
-- passed, on the same code path. An incidental mention is not an
-- understanding of the statement that carries it.
COMMENT ON FUNCTION tenancy.f(uuid) IS 'note';
