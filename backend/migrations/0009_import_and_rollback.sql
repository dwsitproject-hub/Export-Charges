-- ECR Technical Design §4.2.3 (bulk import) and §4.2.6 (rollback).
--
-- Rollback of data version v is an ordinary change set (kind ROLLBACK, rollback_of_version = v) reviewed by a second
-- Checker. Records that v changed are restored with UPDATE items; records that v created are withdrawn: the new
-- WITHDRAW operation closes the record's current row version without a successor, so it disappears from the
-- current data while every earlier version stays readable. Nothing is deleted.

ALTER TABLE ecr.change_item DROP CONSTRAINT change_item_operation_check;
ALTER TABLE ecr.change_item ADD CONSTRAINT change_item_operation_check
  CHECK (operation IN ('CREATE', 'UPDATE', 'END_DATE', 'WITHDRAW'));

-- Excel imports (PRD F-28, FR-IMP-01). The dry run never writes data: the job keeps the stored file, its hash and
-- the row-level report; commit re-reads the file, validates again and creates one IMPORT change set.
CREATE TABLE ecr.import_job (
  id               uuid PRIMARY KEY DEFAULT uuidv7(),
  uploaded_by      uuid NOT NULL REFERENCES ecr.app_user (id),
  file_name        text NOT NULL,
  file_object_key  text NOT NULL,
  file_sha256      bytea NOT NULL CHECK (length(file_sha256) = 32),
  byte_size        int NOT NULL CHECK (byte_size > 0),
  scan_result      text NOT NULL CHECK (scan_result IN ('CLEAN', 'NOT_SCANNED')),
  template_version text NOT NULL,
  status           text NOT NULL CHECK (status IN ('VALIDATED', 'VALIDATED_WITH_ERRORS', 'COMMITTED')),
  row_count        int NOT NULL,
  error_count      int NOT NULL,
  warning_count    int NOT NULL,
  -- [{sheet, row, column, severity, code, message}]
  report           jsonb NOT NULL,
  change_set_id    uuid UNIQUE REFERENCES ecr.change_set (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  committed_at     timestamptz,
  CONSTRAINT import_job_committed CHECK ((status = 'COMMITTED') = (change_set_id IS NOT NULL))
);
CREATE INDEX import_job_uploader_idx ON ecr.import_job (uploaded_by, created_at DESC);

-- Lineage: which sheet row an imported item came from ("Products!7").
ALTER TABLE ecr.change_item ADD COLUMN import_row text;
