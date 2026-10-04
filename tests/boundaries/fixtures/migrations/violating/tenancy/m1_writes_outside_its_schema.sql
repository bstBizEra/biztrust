-- control 4: a migration under tenancy/ creates a table in the audit schema.
CREATE TABLE audit.smuggled (tenant_id uuid, id uuid PRIMARY KEY);
