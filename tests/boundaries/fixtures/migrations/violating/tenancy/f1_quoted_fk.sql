-- One violation only: a cross-schema foreign key written with quoted names.
CREATE TABLE tenancy.linked_quoted (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  aud uuid REFERENCES "audit"."decision" (id)
);
