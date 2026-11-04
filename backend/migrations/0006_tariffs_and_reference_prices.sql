-- ECR Technical Design §7.2: export duty (BK) and levy (PE) schedules with band tables, and reference-price,
-- Harga Ekspor and FX series. All versioned and maintained through change sets like the registry (0004).
-- Slice note: reference series are change-set records too (the design kept them as a plain table), so a new
-- Harga Ekspor series for a product is reviewed like any other change.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE ecr.entity_key DROP CONSTRAINT entity_key_entity_type_check;
ALTER TABLE ecr.entity_key ADD CONSTRAINT entity_key_entity_type_check CHECK (entity_type IN (
  'REGULATION', 'COMMODITY', 'PRODUCT_GROUP', 'PRODUCT', 'REF_SERIES', 'REF_VALUE', 'BAND_TABLE', 'SCHEDULE', 'SCHEDULE_LINE'));
ALTER TABLE ecr.change_item DROP CONSTRAINT change_item_entity_type_check;
ALTER TABLE ecr.change_item ADD CONSTRAINT change_item_entity_type_check CHECK (entity_type IN (
  'REGULATION', 'COMMODITY', 'PRODUCT_GROUP', 'PRODUCT', 'REF_SERIES', 'REF_VALUE', 'BAND_TABLE', 'SCHEDULE', 'SCHEDULE_LINE'));

-- ---------------------------------------------------------------- reference series and values

CREATE TABLE ecr.ref_series (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id         uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from        date NOT NULL DEFAULT '-infinity',
  valid_to          date,
  version_from      int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to        int REFERENCES ecr.data_version (version_no),
  change_set_id     uuid NOT NULL REFERENCES ecr.change_set (id),
  code              text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,40}$'),
  name              text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('REFERENCE_PRICE', 'HARGA_EKSPOR', 'FX_RATE')),
  unit              text NOT NULL,
  cadence           text NOT NULL CHECK (cadence IN ('MONTHLY', 'HALF_MONTHLY', 'WEEKLY')),
  product_entity_id uuid REFERENCES ecr.entity_key (entity_id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ref_series_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT ref_series_versions CHECK (version_to IS NULL OR version_to > version_from),
  -- A Harga Ekspor series belongs to one product; reference prices and FX do not.
  CONSTRAINT ref_series_he_product CHECK ((kind = 'HARGA_EKSPOR') = (product_entity_id IS NOT NULL))
);
CREATE UNIQUE INDEX ref_series_current_uq ON ecr.ref_series (entity_id) WHERE version_to IS NULL;
CREATE UNIQUE INDEX ref_series_code_uq ON ecr.ref_series (code) WHERE version_to IS NULL;
CREATE INDEX ref_series_entity_idx ON ecr.ref_series (entity_id, version_from);
CREATE TRIGGER ref_series_guard BEFORE UPDATE OR DELETE ON ecr.ref_series
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.ref_value (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id          uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  -- Mirror the period: valid_from = period_from, valid_to = period_to + 1 (exclusive).
  valid_from         date NOT NULL,
  valid_to           date NOT NULL,
  version_from       int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to         int REFERENCES ecr.data_version (version_no),
  change_set_id      uuid NOT NULL REFERENCES ecr.change_set (id),
  series_entity_id   uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  period_from        date NOT NULL,
  period_to          date NOT NULL,
  value              numeric(18, 6) NOT NULL CHECK (value > 0),
  -- BR-SRC-01: every published value has its official source document.
  source_document_id uuid NOT NULL REFERENCES ecr.source_document (id),
  source_reference   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ref_value_period CHECK (period_to >= period_from AND valid_from = period_from AND valid_to = period_to + 1),
  CONSTRAINT ref_value_versions CHECK (version_to IS NULL OR version_to > version_from),
  -- BR-REF-01: periods of one series never overlap among current versions.
  CONSTRAINT ref_value_no_overlap EXCLUDE USING gist (series_entity_id WITH =, daterange(valid_from, valid_to) WITH &&)
    WHERE (version_to IS NULL)
);
CREATE UNIQUE INDEX ref_value_current_uq ON ecr.ref_value (entity_id) WHERE version_to IS NULL;
CREATE INDEX ref_value_series_idx ON ecr.ref_value (series_entity_id, period_from) WHERE version_to IS NULL;
CREATE INDEX ref_value_entity_idx ON ecr.ref_value (entity_id, version_from);
CREATE TRIGGER ref_value_guard BEFORE UPDATE OR DELETE ON ecr.ref_value
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

-- ---------------------------------------------------------------- band tables

CREATE TABLE ecr.band_table (
  id                    uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id             uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from            date NOT NULL DEFAULT '-infinity',
  valid_to              date,
  version_from          int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to            int REFERENCES ecr.data_version (version_no),
  change_set_id         uuid NOT NULL REFERENCES ecr.change_set (id),
  code                  text NOT NULL CHECK (code ~ '^[A-Z0-9-]{2,40}$'),
  name                  text NOT NULL,
  ref_series_entity_id  uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT band_table_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT band_table_versions CHECK (version_to IS NULL OR version_to > version_from)
);
CREATE UNIQUE INDEX band_table_current_uq ON ecr.band_table (entity_id) WHERE version_to IS NULL;
CREATE UNIQUE INDEX band_table_code_uq ON ecr.band_table (code) WHERE version_to IS NULL;
CREATE INDEX band_table_entity_idx ON ecr.band_table (entity_id, version_from);
CREATE TRIGGER band_table_guard BEFORE UPDATE OR DELETE ON ecr.band_table
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.band (
  band_table_row_id uuid NOT NULL REFERENCES ecr.band_table (id),
  ordinal           int NOT NULL CHECK (ordinal > 0),
  -- Null lower = from 0; null upper = no ceiling. Contiguity is checked on submit (BR-TRF-02).
  lower_exclusive   numeric(14, 4),
  upper_inclusive   numeric(14, 4),
  label             text NOT NULL,
  PRIMARY KEY (band_table_row_id, ordinal),
  CONSTRAINT band_bounds CHECK (lower_exclusive IS NULL OR upper_inclusive IS NULL OR upper_inclusive > lower_exclusive)
);
CREATE TRIGGER band_guard BEFORE UPDATE OR DELETE ON ecr.band
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();

-- ---------------------------------------------------------------- schedules and lines

CREATE TABLE ecr.schedule (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id            uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from           date NOT NULL DEFAULT '-infinity',
  valid_to             date,
  version_from         int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to           int REFERENCES ecr.data_version (version_no),
  change_set_id        uuid NOT NULL REFERENCES ecr.change_set (id),
  regulation_entity_id uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  charge_type          text NOT NULL CHECK (charge_type IN ('BK', 'PE')),
  annex_label          text NOT NULL,
  commodity_entity_id  uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT schedule_versions CHECK (version_to IS NULL OR version_to > version_from)
);
CREATE UNIQUE INDEX schedule_current_uq ON ecr.schedule (entity_id) WHERE version_to IS NULL;
CREATE INDEX schedule_entity_idx ON ecr.schedule (entity_id, version_from);
CREATE TRIGGER schedule_guard BEFORE UPDATE OR DELETE ON ecr.schedule
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.schedule_line (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id            uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from           date NOT NULL,
  valid_to             date,
  version_from         int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to           int REFERENCES ecr.data_version (version_no),
  change_set_id        uuid NOT NULL REFERENCES ecr.change_set (id),
  schedule_entity_id   uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  kelompok             text,
  item_no              text,
  uraian               text NOT NULL,
  basis_type           text NOT NULL CHECK (basis_type IN
                         ('BAND_USD_PER_MT', 'AD_VALOREM_PCT', 'BAND_PCT', 'PCT_OF_REF_PRICE', 'FIXED_USD_PER_MT', 'ZERO_LISTED')),
  pct                  numeric(7, 4) CHECK (pct > 0 AND pct <= 100),
  usd_per_mt           numeric(14, 4) CHECK (usd_per_mt >= 0),
  band_table_entity_id uuid REFERENCES ecr.entity_key (entity_id),
  ref_series_entity_id uuid REFERENCES ecr.entity_key (entity_id),
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT schedule_line_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT schedule_line_versions CHECK (version_to IS NULL OR version_to > version_from),
  -- BR-TRF-04: banded and %-of-reference bases name their reference series (and banded ones their band table).
  CONSTRAINT schedule_line_basis CHECK (CASE basis_type
    WHEN 'BAND_USD_PER_MT'  THEN band_table_entity_id IS NOT NULL AND ref_series_entity_id IS NOT NULL
    WHEN 'BAND_PCT'         THEN band_table_entity_id IS NOT NULL AND ref_series_entity_id IS NOT NULL
    WHEN 'PCT_OF_REF_PRICE' THEN pct IS NOT NULL AND ref_series_entity_id IS NOT NULL
    WHEN 'AD_VALOREM_PCT'   THEN pct IS NOT NULL
    WHEN 'FIXED_USD_PER_MT' THEN usd_per_mt IS NOT NULL
    ELSE true END)
);
CREATE UNIQUE INDEX schedule_line_current_uq ON ecr.schedule_line (entity_id) WHERE version_to IS NULL;
CREATE INDEX schedule_line_schedule_idx ON ecr.schedule_line (schedule_entity_id) WHERE version_to IS NULL;
CREATE INDEX schedule_line_entity_idx ON ecr.schedule_line (entity_id, version_from);
CREATE TRIGGER schedule_line_guard BEFORE UPDATE OR DELETE ON ecr.schedule_line
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.schedule_line_product (
  schedule_line_row_id uuid NOT NULL REFERENCES ecr.schedule_line (id),
  product_entity_id    uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  PRIMARY KEY (schedule_line_row_id, product_entity_id)
);
CREATE INDEX schedule_line_product_idx ON ecr.schedule_line_product (product_entity_id);
CREATE TRIGGER schedule_line_product_guard BEFORE UPDATE OR DELETE ON ecr.schedule_line_product
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();

CREATE TABLE ecr.schedule_line_band_value (
  schedule_line_row_id uuid NOT NULL REFERENCES ecr.schedule_line (id),
  band_ordinal         int NOT NULL CHECK (band_ordinal > 0),
  -- USD/MT for BAND_USD_PER_MT, % for BAND_PCT.
  amount               numeric(14, 4) NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (schedule_line_row_id, band_ordinal)
);
CREATE TRIGGER schedule_line_band_value_guard BEFORE UPDATE OR DELETE ON ecr.schedule_line_band_value
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();
