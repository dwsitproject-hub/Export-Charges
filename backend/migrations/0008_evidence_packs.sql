-- ECR Technical Design §4.3.3 and §7.3: PDF/A evidence packs. One pack per saved calculation; the pack records the
-- exact payload printed in the PDF (its SHA-256 is in every page footer) and the SHA-256 of the PDF file, so a
-- verifier can check both the document and the figures, and replay the calculation at its data version.
-- CSV/XLSX exports are streamed and only audited (EXPORT_DOWNLOADED); they have no table.

CREATE TABLE ecr.evidence_pack (
  evidence_id      text PRIMARY KEY CHECK (evidence_id ~ '^EV-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  calculation_id   uuid NOT NULL UNIQUE REFERENCES ecr.calculation (id),
  payload          jsonb NOT NULL,
  payload_sha256   bytea NOT NULL CHECK (length(payload_sha256) = 32),
  object_key       text NOT NULL UNIQUE,
  pdf_sha256       bytea NOT NULL CHECK (length(pdf_sha256) = 32),
  byte_size        int NOT NULL CHECK (byte_size > 0),
  pdfa_profile     text NOT NULL DEFAULT 'PDF/A-2b',
  created_by       uuid NOT NULL REFERENCES ecr.app_user (id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Decision D7: evidence is kept 10 years.
  retain_until     date NOT NULL
);
CREATE INDEX evidence_pack_creator_idx ON ecr.evidence_pack (created_by, created_at DESC);

CREATE TRIGGER evidence_pack_immutable_trg BEFORE UPDATE OR DELETE ON ecr.evidence_pack
FOR EACH ROW EXECUTE FUNCTION ecr.calculation_immutable();
