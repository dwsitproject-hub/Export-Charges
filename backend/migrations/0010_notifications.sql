-- ECR notifications (PRD L2-5 step 2, US-29-P1 AC1, US-29-N2 AC1, F-48 / FR-NTF-01; Technical Design §4.2.7, §7.3).
-- Notifications are written in the same transaction as the workflow change that causes them (transactional outbox);
-- the in-process email-outbox job sends the emails. Emails carry a title and a link, never draft data (US-48-N1 AC2).

CREATE TABLE ecr.notification (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES ecr.app_user (id),
  kind          text NOT NULL,
  title         text NOT NULL,
  body          text NOT NULL,
  link          text NOT NULL CHECK (link LIKE '/%'),
  change_set_id uuid REFERENCES ecr.change_set (id),
  version_no    int REFERENCES ecr.data_version (version_no),
  -- One notice per user and event, e.g. one per published version however many subscriptions match (US-48-N1 AC1).
  dedupe_key    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX notification_user_idx ON ecr.notification (user_id, created_at DESC);
CREATE INDEX notification_unread_idx ON ecr.notification (user_id) WHERE read_at IS NULL;

CREATE TABLE ecr.email_outbox (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  notification_id uuid REFERENCES ecr.notification (id),
  to_user_id      uuid NOT NULL REFERENCES ecr.app_user (id),
  to_email        text NOT NULL,
  subject         text NOT NULL,
  body_text       text NOT NULL,
  status          text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'CANCELLED')),
  attempts        int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);
CREATE INDEX email_outbox_due_idx ON ecr.email_outbox (next_attempt_at) WHERE status = 'PENDING';

-- Change subscriptions (US-48-P1): a commodity, a product group or one product.
CREATE TABLE ecr.subscription (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id         uuid NOT NULL REFERENCES ecr.app_user (id),
  scope_type      text NOT NULL CHECK (scope_type IN ('COMMODITY', 'PRODUCT_GROUP', 'PRODUCT')),
  scope_entity_id uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, scope_type, scope_entity_id)
);
CREATE INDEX subscription_scope_idx ON ecr.subscription (scope_entity_id);
