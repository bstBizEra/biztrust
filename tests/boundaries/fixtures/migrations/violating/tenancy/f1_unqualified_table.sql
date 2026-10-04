-- One violation only: no schema qualifier at all.
CREATE TABLE decision (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
