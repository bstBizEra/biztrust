-- Peer review: the unqualified-REFERENCES half of M2 had no fixture.
CREATE TABLE tenancy.unqualified_fk (
  tenant_id uuid NOT NULL,
  id uuid PRIMARY KEY,
  other uuid REFERENCES tenant (tenant_id)
);
