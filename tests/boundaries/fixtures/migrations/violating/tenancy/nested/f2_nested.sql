-- Peer review F2. A flat readdir never saw this file.
CREATE TABLE audit.nested_smuggled (id uuid PRIMARY KEY, tenant_id uuid NOT NULL);
DELETE FROM audit.decision;
