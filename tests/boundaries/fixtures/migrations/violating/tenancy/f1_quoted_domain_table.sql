-- One violation only: a domain table name hidden behind double quotes.
CREATE TABLE tenancy."policy" (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
