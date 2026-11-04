-- ECR Technical Design §4.2.7: scheduled jobs. Each run is recorded; a database advisory lock makes sure only one
-- API instance runs a job at a time. Times are WIB (UTC+7).

CREATE TABLE ecr.job_run (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  job_name     text NOT NULL,
  status       text NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'OK', 'FAILED')),
  -- NULL = started by the scheduler; otherwise the Super Admin who pressed "Run now".
  triggered_by uuid REFERENCES ecr.app_user (id),
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  details      jsonb,
  error        text
);
CREATE INDEX job_run_name_idx ON ecr.job_run (job_name, started_at DESC);

-- Dormancy (BR-IAM-11): the day-80 warning is sent once per period of inactivity, and a reactivation by a User Admin
-- restarts the 90 days, so the job does not disable the account again the next night.
ALTER TABLE ecr.app_user
  ADD COLUMN dormancy_warned_at timestamptz,
  ADD COLUMN reactivated_at     timestamptz;

-- Nightly data-quality runs on published data store their findings without a change set.
CREATE INDEX dq_finding_nightly_idx ON ecr.dq_finding (created_at DESC) WHERE change_set_id IS NULL;
