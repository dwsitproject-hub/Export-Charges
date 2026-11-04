-- ECR Technical Design §4.1.7 and PRD F-12 (L2-1.9): quarterly access reviews. Every live role assignment becomes
-- an item that a reviewer keeps or revokes; items still open after 14 days are escalated to Super Admins. When the
-- last item is decided the campaign closes and a signed PDF/A report is stored for auditors.

INSERT INTO ecr.permission (code, description, sod_group) VALUES
  ('accessreview.read', 'See access review campaigns and download their signed reports', NULL);

INSERT INTO ecr.role_permission (role_id, permission_code)
SELECT r.id, 'accessreview.read' FROM ecr.role r WHERE r.code IN ('USER_ADMIN', 'SUPER_ADMIN', 'AUDITOR');

CREATE TABLE ecr.access_review_campaign (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  period_label       text NOT NULL UNIQUE,                 -- e.g. 2026-Q4
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'CLOSED')),
  -- NULL = started by the quarterly job; otherwise the Super Admin who pressed "Run now".
  started_by         uuid REFERENCES ecr.app_user (id),
  started_at         timestamptz NOT NULL DEFAULT now(),
  due_at             timestamptz NOT NULL,                 -- started_at + 14 days; open items escalate after this
  closed_at          timestamptz,
  closed_by          uuid REFERENCES ecr.app_user (id),    -- who decided the last item
  -- The signed report: what it prints (payload), the SHA-256 of that content, an HMAC-SHA256 of the content hash
  -- with the ECR server key (both printed in every page footer) and the SHA-256 of the stored PDF file.
  report_payload        jsonb,
  report_content_sha256 bytea,
  report_signature      bytea,
  report_object_key     text,
  report_sha256         bytea,
  report_byte_size      integer,
  CONSTRAINT access_review_closed CHECK ((status = 'CLOSED') = (closed_at IS NOT NULL)),
  CONSTRAINT access_review_report CHECK (status = 'OPEN' OR (report_object_key IS NOT NULL AND report_signature IS NOT NULL))
);

CREATE TABLE ecr.access_review_item (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  campaign_id    uuid NOT NULL REFERENCES ecr.access_review_campaign (id),
  user_role_id   uuid NOT NULL REFERENCES ecr.user_role (id),
  user_id        uuid NOT NULL REFERENCES ecr.app_user (id),
  role_id        uuid NOT NULL REFERENCES ecr.role (id),
  -- Snapshot when the campaign started, so the report shows what the reviewer saw.
  user_status    text NOT NULL,
  last_login_at  timestamptz,
  granted_at     timestamptz NOT NULL,
  -- BR-IAM-02: assignments of users who hold an administrator role are reviewed by a Super Admin.
  reviewer_role  text NOT NULL CHECK (reviewer_role IN ('USER_ADMIN', 'SUPER_ADMIN')),
  decision       text CHECK (decision IN ('KEEP', 'REVOKE')),
  reason         text,
  reviewer_id    uuid REFERENCES ecr.app_user (id),
  decided_at     timestamptz,
  escalated_at   timestamptz,
  UNIQUE (campaign_id, user_role_id),
  CONSTRAINT access_review_not_self CHECK (reviewer_id IS NULL OR reviewer_id <> user_id), -- SoD-3
  CONSTRAINT access_review_decided CHECK ((decision IS NULL) = (decided_at IS NULL) AND (decision IS NULL) = (reviewer_id IS NULL)),
  CONSTRAINT access_review_revoke_reason CHECK (decision IS DISTINCT FROM 'REVOKE' OR reason IS NOT NULL)
);
CREATE INDEX access_review_item_open_idx ON ecr.access_review_item (campaign_id) WHERE decision IS NULL;
