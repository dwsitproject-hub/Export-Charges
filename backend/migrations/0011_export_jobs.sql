-- ECR Technical Design §4.3.3 "Large export" (PRD US-47-N1 AC3): a catalogue export above the synchronous limit runs
-- as a job. The file goes to the object store, the requester is notified (in ECR and by email) with a link that opens
-- only through ECR after sign-in, and the file can be downloaded by that person only, for 24 hours. Afterwards the file
-- is removed and the job is kept as a record.

CREATE TABLE ecr.export_job (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  requested_by  uuid NOT NULL REFERENCES ecr.app_user (id),
  kind          text NOT NULL CHECK (kind IN ('CATALOGUE')),
  format        text NOT NULL CHECK (format IN ('csv', 'xlsx')),
  -- The catalogue query (search, filters, sort, date) with the data version pinned when the export was requested.
  query         jsonb NOT NULL,
  version_no    int NOT NULL REFERENCES ecr.data_version (version_no),
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
  attempts      int NOT NULL DEFAULT 0,
  row_count     int,
  file_name     text,
  object_key    text UNIQUE,
  byte_size     int,
  sha256        bytea CHECK (sha256 IS NULL OR length(sha256) = 32),
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  expires_at    timestamptz,
  CONSTRAINT export_job_ready CHECK (status <> 'READY' OR (object_key IS NOT NULL AND sha256 IS NOT NULL AND expires_at IS NOT NULL))
);
CREATE INDEX export_job_queue_idx ON ecr.export_job (created_at) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX export_job_owner_idx ON ecr.export_job (requested_by, created_at DESC);
CREATE INDEX export_job_expiry_idx ON ecr.export_job (expires_at) WHERE status = 'READY';
