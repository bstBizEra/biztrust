-- Registry-membership fixture for the CAST TYPE scan (round two re-review,
-- follow-up to finding 1): a cast to this directory's OWN schema, and a
-- cast to a schema no module owns (pg_catalog, information_schema), must
-- both stay silent - with or without a typmod - because "another module's
-- schema" specifically means a schema some OTHER registered module owns,
-- not merely any schema that is not this directory's own.
CREATE TABLE tenancy.cast_type_own_and_builtin_ok (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  own_typmod_val numeric NOT NULL DEFAULT '0'::tenancy.custom_domain(10),
  own_plain_val text NOT NULL DEFAULT ''::tenancy.custom_domain2,
  pg_catalog_typmod_val numeric NOT NULL DEFAULT '0'::pg_catalog.numeric(10,2),
  pg_catalog_plain_val text NOT NULL DEFAULT ''::pg_catalog.text,
  info_schema_plain_val text NOT NULL DEFAULT ''::information_schema.sql_identifier
);
