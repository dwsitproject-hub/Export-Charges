-- ECR Technical Design §7 and PRD F-52 (FR-CFG-01): settings a Super Admin changes on the Configuration screen.
-- A row overrides the deployment's environment value for that key; deleting it restores the default. The allowed
-- ranges (US-52-N1) live in the API, so they cannot be loosened by editing this table. Every change is audited.

CREATE TABLE ecr.system_config (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_by uuid NOT NULL REFERENCES ecr.app_user (id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
