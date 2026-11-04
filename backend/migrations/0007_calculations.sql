-- ECR Technical Design §4.3.2 and §7.3: saved charge calculations. A calculation records its inputs, the data
-- version V it used and its full result, so replaying the inputs at V must give identical numbers (NFR-AUD-01).
-- Saved calculations are evidence and never change.

CREATE TABLE ecr.calculation (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  created_by            uuid NOT NULL REFERENCES ecr.app_user (id),
  peb_date              date NOT NULL,
  payment_date          date NOT NULL,
  version_no            int NOT NULL REFERENCES ecr.data_version (version_no),
  -- What-if reference price (US-44-P2); a simulation can never become official evidence.
  is_simulation         boolean NOT NULL,
  ref_price_override    numeric(18, 6),
  status                text NOT NULL CHECK (status IN ('COMPLETE', 'INCOMPLETE')),
  inputs                jsonb NOT NULL,
  inputs_hash           bytea NOT NULL CHECK (length(inputs_hash) = 32),
  result                jsonb NOT NULL,
  result_hash           bytea NOT NULL CHECK (length(result_hash) = 32),
  total_usd             numeric(20, 6),
  total_idr             numeric(22, 0),
  fx_value              numeric(18, 6),
  fx_source_document_id uuid REFERENCES ecr.source_document (id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calculation_simulation CHECK (is_simulation = (ref_price_override IS NOT NULL)),
  CONSTRAINT calculation_complete CHECK (status = 'INCOMPLETE' OR total_usd IS NOT NULL)
);
CREATE INDEX calculation_creator_idx ON ecr.calculation (created_by, created_at DESC);

CREATE TABLE ecr.calculation_line (
  calculation_id      uuid NOT NULL REFERENCES ecr.calculation (id),
  ordinal             int NOT NULL CHECK (ordinal BETWEEN 1 AND 50),
  product_entity_id   uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  quantity_mt         numeric(14, 3) NOT NULL CHECK (quantity_mt > 0 AND quantity_mt <= 1000000),
  bk_status           text NOT NULL,
  bk_basis            text,
  bk_line_entity_id   uuid,
  bk_per_mt           numeric(20, 6),
  bk_total_usd        numeric(20, 6),
  pe_status           text NOT NULL,
  pe_basis            text,
  pe_line_entity_id   uuid,
  pe_per_mt           numeric(20, 6),
  pe_total_usd        numeric(20, 6),
  ref_value_entity_id uuid,
  he_value_entity_id  uuid,
  band_ordinal        int,
  he_fallback         boolean NOT NULL DEFAULT false,
  warnings            jsonb NOT NULL DEFAULT '[]',
  PRIMARY KEY (calculation_id, ordinal)
);
CREATE INDEX calculation_line_product_idx ON ecr.calculation_line (product_entity_id);

CREATE FUNCTION ecr.calculation_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are evidence and cannot be changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER calculation_immutable_trg BEFORE UPDATE OR DELETE ON ecr.calculation
FOR EACH ROW EXECUTE FUNCTION ecr.calculation_immutable();
CREATE TRIGGER calculation_line_immutable_trg BEFORE UPDATE OR DELETE ON ecr.calculation_line
FOR EACH ROW EXECUTE FUNCTION ecr.calculation_immutable();
