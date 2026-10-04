-- control 5: a foreign key from a tenancy table to an audit table.
CREATE TABLE tenancy.linked (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  audit_id uuid REFERENCES audit.decision (decision_id)
);
