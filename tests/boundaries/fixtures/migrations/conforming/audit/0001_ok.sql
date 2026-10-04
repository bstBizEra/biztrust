CREATE SCHEMA IF NOT EXISTS audit;
CREATE TABLE audit.decision (
  tenant_id uuid NOT NULL,
  decision_id uuid PRIMARY KEY,
  recorded_at timestamptz NOT NULL
);
ALTER TABLE audit.decision ADD COLUMN authority_reference text;
