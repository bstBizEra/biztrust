-- Round two re-review, follow-up to finding 1: a schema-qualified TYPE
-- REFERENCE in cast position, carrying a typmod, that names another
-- REGISTERED module's schema. Before finding 1's fix this fired (as a
-- misidentified call, but a true foreign-schema positive); after it, it
-- went silent for every schema, foreign included. The CAST TYPE scan
-- closes this without reopening the call misdetection.
CREATE TABLE tenancy.probe_cast_type_with_typmod (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  status_val numeric NOT NULL DEFAULT '0'::audit.decision_status(10)
);
