-- ECR keeps itself in step with the official sources. The monthly CPO reference price (Kepmendag) and the weekly KMK
-- USD/IDR rate are read, checked and published by themselves, and every user is told. A value that fails a check, and
-- every new regulation that touches ECR's data (amending or revoking one it holds, or carrying new palm duty or levy
-- tables), is drafted as a change set and sent to the Checkers instead.

-- The account the automatic updates are recorded under (change sets, stored PDFs, audit events). It is deactivated
-- and has no DWS Hub identity, and its address cannot exist (.invalid), so nobody can ever sign in as it.
INSERT INTO ecr.app_user (id, email, full_name, status, deactivated_reason)
VALUES ('00000000-0000-0000-0000-00000000ec01', 'auto-update@ecr.invalid', 'ECR automatic update', 'DEACTIVATED',
        'System account: records the automatic updates of the CPO reference price and the KMK rate. It cannot sign in.')
ON CONFLICT DO NOTHING;

-- Every official decree the job has handled, so each is processed once (a failed download is retried; a decree that
-- needs a person is reported once and then left to the Makers).
CREATE TABLE ecr.auto_update_source (
  source_key    text PRIMARY KEY,                 -- CPO|2064|2026, FX|53/MK/EF.2/2026, REG|<BPK page>
  kind          text NOT NULL CHECK (kind IN ('CPO', 'FX', 'REGULATION')),
  decree        text NOT NULL,                    -- "Kepmendag 2064/2026", "KMK 53/MK/EF.2/2026"
  page_url      text NOT NULL,
  pdf_url       text,
  outcome       text NOT NULL CHECK (outcome IN ('PUBLISHED', 'SENT_TO_CHECKER', 'ALREADY_PUBLISHED', 'OLDER_PERIOD', 'NOT_RELEVANT', 'NEEDS_REVIEW')),
  value         numeric(18, 4),
  period_from   date,
  period_to     date,
  data_version  integer,
  change_set_id uuid REFERENCES ecr.change_set (id),
  detail        text,
  handled_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auto_update_source_handled_idx ON ecr.auto_update_source (handled_at DESC);
