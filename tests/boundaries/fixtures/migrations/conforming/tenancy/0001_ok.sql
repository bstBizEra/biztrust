CREATE SCHEMA IF NOT EXISTS tenancy;
CREATE TABLE tenancy.tenant (
  tenant_id uuid PRIMARY KEY,
  organization_id text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE TABLE tenancy.legal_entity (
  tenant_id uuid NOT NULL,
  legal_entity_id uuid PRIMARY KEY,
  parent_tenant_id uuid REFERENCES tenancy.tenant (tenant_id)
);
