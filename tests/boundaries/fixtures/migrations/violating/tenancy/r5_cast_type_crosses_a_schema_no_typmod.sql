-- Round two re-review, follow-up to finding 1: a schema-qualified TYPE
-- REFERENCE in cast position, with NO typmod, that names another
-- REGISTERED module's schema. This form was never caught, before or after
-- finding 1's fix - the EXPR CALL scan never matched it either (no trailing
-- "(" for that shape), and nothing else looked inside a cast at all.
CREATE TABLE tenancy.probe_cast_type_no_typmod (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  status_val text NOT NULL DEFAULT ''::audit.decision_status
);
