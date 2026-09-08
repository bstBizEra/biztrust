-- One violation only: a double-quoted schema name writing outside this module.
CREATE TABLE "audit"."evidence" (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
