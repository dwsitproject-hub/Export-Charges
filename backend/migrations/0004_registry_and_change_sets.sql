-- ECR Technical Design §4.2, §7.2 and §7.3: regulation register, official source documents, commodities,
-- product master with HS codes, and the maker-checker change-set workflow that publishes them.
--
-- Versioned tables (Technical Design §6 conventions): one entity_key per logical record, one row per version.
--   valid_from / valid_to   business validity (valid_to exclusive; '-infinity' when the law gives no start)
--   version_from / version_to   the data versions in which the row was current (version_to NULL = current)
-- Rows are never updated except to close them (version_to) and never deleted (US-30-N1).
-- Slice note: parameters, HS codes, relations and documents are children of their parent's row version, so a
-- product or regulation and everything printed with it are reviewed and published as one item.

-- ---------------------------------------------------------------- workflow

CREATE TABLE ecr.change_set (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  title               text NOT NULL CHECK (length(title) BETWEEN 3 AND 200),
  justification       text NOT NULL,
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'REJECTED', 'APPROVED', 'SCHEDULED', 'PUBLISHED', 'CANCELLED')),
  kind                text NOT NULL DEFAULT 'NORMAL' CHECK (kind IN ('NORMAL', 'IMPORT', 'ROLLBACK')),
  created_by          uuid NOT NULL REFERENCES ecr.app_user (id),
  submitted_at        timestamptz,
  reviewed_by         uuid REFERENCES ecr.app_user (id),
  review_started_at   timestamptz,
  decision_comment    text,
  approved_at         timestamptz,
  effective_at        timestamptz,
  version_no          int,
  rollback_of_version int,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT change_set_sod1 CHECK (reviewed_by IS NULL OR reviewed_by <> created_by),
  CONSTRAINT change_set_reject_comment CHECK (status <> 'REJECTED' OR decision_comment IS NOT NULL),
  CONSTRAINT change_set_scheduled_at CHECK (status <> 'SCHEDULED' OR effective_at IS NOT NULL)
);
CREATE INDEX change_set_status_idx ON ecr.change_set (status);
CREATE INDEX change_set_creator_idx ON ecr.change_set (created_by, status);
CREATE INDEX change_set_due_idx ON ecr.change_set (effective_at) WHERE status = 'SCHEDULED';

CREATE TABLE ecr.data_version (
  version_no             int PRIMARY KEY CHECK (version_no > 0),
  change_set_id          uuid NOT NULL UNIQUE REFERENCES ecr.change_set (id),
  published_at           timestamptz NOT NULL DEFAULT now(),
  published_by           uuid REFERENCES ecr.app_user (id),
  bulletin               jsonb NOT NULL,
  rolled_back_by_version int REFERENCES ecr.data_version (version_no)
);
ALTER TABLE ecr.change_set
  ADD CONSTRAINT change_set_version_fk FOREIGN KEY (version_no) REFERENCES ecr.data_version (version_no),
  ADD CONSTRAINT change_set_rollback_fk FOREIGN KEY (rollback_of_version) REFERENCES ecr.data_version (version_no);

CREATE TABLE ecr.entity_key (
  entity_id   uuid PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('REGULATION', 'COMMODITY', 'PRODUCT_GROUP', 'PRODUCT')),
  natural_key text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX entity_key_natural_idx ON ecr.entity_key (entity_type, natural_key);

CREATE TABLE ecr.change_item (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  change_set_id uuid NOT NULL REFERENCES ecr.change_set (id),
  entity_type   text NOT NULL CHECK (entity_type IN ('REGULATION', 'COMMODITY', 'PRODUCT_GROUP', 'PRODUCT')),
  -- Allocated when a CREATE item is first saved so items in one set can refer to each other;
  -- the entity_key row itself is written by the publish transaction.
  entity_id     uuid NOT NULL,
  operation     text NOT NULL CHECK (operation IN ('CREATE', 'UPDATE', 'END_DATE')),
  base_row_id   uuid,
  before        jsonb,
  after         jsonb NOT NULL,
  edited_by     uuid[] NOT NULL,
  is_open       boolean NOT NULL DEFAULT true,
  item_comment  text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT change_item_base CHECK ((operation = 'CREATE') = (base_row_id IS NULL)),
  CONSTRAINT change_item_before CHECK ((operation = 'CREATE') = (before IS NULL))
);
-- One open edit per record across all change sets (US-23-N2).
CREATE UNIQUE INDEX change_item_one_open_edit ON ecr.change_item (entity_type, entity_id) WHERE is_open;
CREATE INDEX change_item_set_idx ON ecr.change_item (change_set_id);

CREATE TABLE ecr.dq_finding (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  change_set_id   uuid REFERENCES ecr.change_set (id),
  run_id          uuid NOT NULL,
  rule_code       text NOT NULL,
  severity        text NOT NULL CHECK (severity IN ('ERROR', 'WARNING', 'INFO')),
  entity_type     text,
  entity_id       uuid,
  field           text,
  message         text NOT NULL,
  acknowledged_by uuid REFERENCES ecr.app_user (id),
  acknowledged_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dq_finding_ack_warning CHECK (acknowledged_by IS NULL OR severity = 'WARNING')
);
CREATE INDEX dq_finding_set_idx ON ecr.dq_finding (change_set_id);

-- ---------------------------------------------------------------- official sources (PRD 13.1, BR-SRC-01)

CREATE TABLE ecr.source_publisher (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  name        text NOT NULL,
  domain      text NOT NULL UNIQUE CHECK (domain = lower(domain)),
  data_types  text[] NOT NULL,
  is_official boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ecr.source_publisher (name, domain, data_types, is_official) VALUES
  ('JDIH Kementerian Keuangan',             'jdih.kemenkeu.go.id',  '{REGULATION,HE_DECISION}', true),
  ('Database Peraturan BPK',                'peraturan.bpk.go.id',  '{REGULATION}', true),
  ('peraturan.go.id (Kemenkumham)',         'peraturan.go.id',      '{REGULATION}', true),
  ('JDIH Nasional',                         'jdihn.go.id',          '{REGULATION}', true),
  ('JDIH Kementerian Perdagangan',          'jdih.kemendag.go.id',  '{REGULATION,REF_PRICE_DECREE}', true),
  ('Kementerian Perdagangan',               'kemendag.go.id',       '{REF_PRICE_DECREE}', true),
  ('JDIH Kementerian Perindustrian',        'jdih.kemenperin.go.id','{REGULATION}', true),
  ('Badan Kebijakan Fiskal',                'fiskal.kemenkeu.go.id','{FX_DECREE}', true),
  ('Direktorat Jenderal Bea dan Cukai',     'beacukai.go.id',       '{HE_DECISION,REGULATION}', true),
  ('Indonesia National Single Window',      'insw.go.id',           '{HS_CODE}', true),
  ('Badan Pengelola Dana Perkebunan',       'bpdp.or.id',           '{REGULATION}', true),
  ('DDTCNews (secondary reference only)',   'news.ddtc.co.id',      '{OTHER}', false);

CREATE TABLE ecr.source_document (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  publisher_id      uuid REFERENCES ecr.source_publisher (id),
  doc_kind          text NOT NULL CHECK (doc_kind IN ('REGULATION', 'ANNEX', 'REF_PRICE_DECREE', 'HE_DECISION', 'FX_DECREE', 'OTHER')),
  doc_number        text,
  doc_date          date,
  title             text NOT NULL,
  official_url      text,
  object_key        text NOT NULL,
  byte_size         bigint NOT NULL CHECK (byte_size > 0),
  sha256            bytea NOT NULL UNIQUE CHECK (length(sha256) = 32),
  content_type      text NOT NULL CHECK (content_type = 'application/pdf'),
  original_filename text,
  is_secondary      boolean NOT NULL,
  scan_result       text NOT NULL CHECK (scan_result IN ('CLEAN', 'NOT_SCANNED')),
  uploaded_by       uuid NOT NULL REFERENCES ecr.app_user (id),
  last_rechecked_at timestamptz,
  recheck_mismatch  boolean NOT NULL DEFAULT false,
  created_at        timestamptz NOT NULL DEFAULT now(),
  -- A source of record comes from an allow-listed official publisher (BR-SRC-01).
  CONSTRAINT source_document_official CHECK (is_secondary OR publisher_id IS NOT NULL)
);

-- Source documents are evidence: only the weekly re-check columns may change, and nothing is deleted (US-21-N1).
CREATE FUNCTION ecr.source_document_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'source_document rows cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - '{last_rechecked_at,recheck_mismatch}'::text[])
     IS DISTINCT FROM (to_jsonb(OLD) - '{last_rechecked_at,recheck_mismatch}'::text[]) THEN
    RAISE EXCEPTION 'source_document rows are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER source_document_immutable_trg
BEFORE UPDATE OR DELETE ON ecr.source_document
FOR EACH ROW EXECUTE FUNCTION ecr.source_document_immutable();

-- ---------------------------------------------------------------- version-row guard

-- Published versions are history: the only allowed change is closing the current version (version_to).
CREATE FUNCTION ecr.version_row_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are history and cannot be deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.version_to IS NOT NULL
     OR (to_jsonb(NEW) - 'version_to') IS DISTINCT FROM (to_jsonb(OLD) - 'version_to') THEN
    RAISE EXCEPTION '% rows are history and cannot be changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;

-- Children belong to one row version and are written only with it.
CREATE FUNCTION ecr.child_row_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are history and cannot be changed', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$;

-- ---------------------------------------------------------------- regulation register

CREATE TABLE ecr.regulation (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id      uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from     date NOT NULL DEFAULT '-infinity',
  valid_to       date,
  version_from   int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to     int REFERENCES ecr.data_version (version_no),
  change_set_id  uuid NOT NULL REFERENCES ecr.change_set (id),
  reg_type       text NOT NULL CHECK (reg_type IN ('UU', 'PP', 'PERPRES', 'PMK', 'KMK', 'PERMENDAG', 'KEPMENDAG', 'PERMENPERIN', 'OTHER')),
  number         text NOT NULL,
  year           int NOT NULL CHECK (year BETWEEN 1945 AND 2100),
  title_id       text NOT NULL,
  title_en       text,
  issuer         text NOT NULL,
  status         text NOT NULL CHECK (status IN ('DRAFT_RANCANGAN', 'PROMULGATED', 'IN_FORCE', 'AMENDED', 'REVOKED')),
  promulgated_on date,
  effective_on   date,
  ends_on        date,
  official_url   text,
  bpk_status_url text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT regulation_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT regulation_versions CHECK (version_to IS NULL OR version_to > version_from),
  CONSTRAINT regulation_dates CHECK (ends_on IS NULL OR effective_on IS NULL OR ends_on >= effective_on)
);
CREATE UNIQUE INDEX regulation_current_uq ON ecr.regulation (entity_id) WHERE version_to IS NULL;
-- BR-REG-01: (type, number, year) unique among current versions.
CREATE UNIQUE INDEX regulation_natural_uq ON ecr.regulation (reg_type, upper(number), year) WHERE version_to IS NULL;
CREATE INDEX regulation_entity_idx ON ecr.regulation (entity_id, version_from);
CREATE TRIGGER regulation_guard BEFORE UPDATE OR DELETE ON ecr.regulation
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.regulation_relation (
  regulation_row_id uuid NOT NULL REFERENCES ecr.regulation (id),
  relation          text NOT NULL CHECK (relation IN ('AMENDS', 'REVOKES', 'IMPLEMENTS')),
  to_regulation_id  uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  PRIMARY KEY (regulation_row_id, relation, to_regulation_id)
);
CREATE INDEX regulation_relation_to_idx ON ecr.regulation_relation (to_regulation_id);
CREATE TRIGGER regulation_relation_guard BEFORE UPDATE OR DELETE ON ecr.regulation_relation
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();

CREATE TABLE ecr.regulation_document (
  regulation_row_id  uuid NOT NULL REFERENCES ecr.regulation (id),
  source_document_id uuid NOT NULL REFERENCES ecr.source_document (id),
  role               text NOT NULL CHECK (role IN ('MAIN', 'ANNEX', 'CORRIGENDUM', 'SECONDARY')),
  PRIMARY KEY (regulation_row_id, source_document_id)
);
CREATE INDEX regulation_document_doc_idx ON ecr.regulation_document (source_document_id);
CREATE TRIGGER regulation_document_guard BEFORE UPDATE OR DELETE ON ecr.regulation_document
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();

-- ---------------------------------------------------------------- commodities and groups

CREATE TABLE ecr.commodity (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id     uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from    date NOT NULL DEFAULT '-infinity',
  valid_to      date,
  version_from  int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to    int REFERENCES ecr.data_version (version_no),
  change_set_id uuid NOT NULL REFERENCES ecr.change_set (id),
  code          text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,20}$'),
  name_id       text NOT NULL,
  name_en       text,
  is_in_scope   boolean NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT commodity_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT commodity_versions CHECK (version_to IS NULL OR version_to > version_from)
);
CREATE UNIQUE INDEX commodity_current_uq ON ecr.commodity (entity_id) WHERE version_to IS NULL;
CREATE UNIQUE INDEX commodity_code_uq ON ecr.commodity (code) WHERE version_to IS NULL;
CREATE INDEX commodity_entity_idx ON ecr.commodity (entity_id, version_from);
CREATE TRIGGER commodity_guard BEFORE UPDATE OR DELETE ON ecr.commodity
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.product_group (
  id                  uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id           uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from          date NOT NULL DEFAULT '-infinity',
  valid_to            date,
  version_from        int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to          int REFERENCES ecr.data_version (version_no),
  change_set_id       uuid NOT NULL REFERENCES ecr.change_set (id),
  commodity_entity_id uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  code                text NOT NULL,
  label               text NOT NULL,
  ordinal             int NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_group_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT product_group_versions CHECK (version_to IS NULL OR version_to > version_from)
);
CREATE UNIQUE INDEX product_group_current_uq ON ecr.product_group (entity_id) WHERE version_to IS NULL;
CREATE UNIQUE INDEX product_group_code_uq ON ecr.product_group (commodity_entity_id, code) WHERE version_to IS NULL;
CREATE INDEX product_group_entity_idx ON ecr.product_group (entity_id, version_from);
CREATE TRIGGER product_group_guard BEFORE UPDATE OR DELETE ON ecr.product_group
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

-- ---------------------------------------------------------------- HS codes (BTKI)

CREATE TABLE ecr.btki_version (
  id                       uuid PRIMARY KEY DEFAULT uuidv7(),
  label                    text NOT NULL UNIQUE,
  legal_basis_regulation_id uuid REFERENCES ecr.entity_key (entity_id),
  effective_on             date NOT NULL,
  is_current               boolean NOT NULL DEFAULT false,
  created_at               timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX btki_version_one_current ON ecr.btki_version (is_current) WHERE is_current;

CREATE TABLE ecr.hs_code (
  id              uuid PRIMARY KEY DEFAULT uuidv7(),
  btki_version_id uuid NOT NULL REFERENCES ecr.btki_version (id),
  code_digits     char(8) NOT NULL CHECK (code_digits ~ '^[0-9]{8}$'),
  code            text GENERATED ALWAYS AS (substr(code_digits, 1, 4) || '.' || substr(code_digits, 5, 2) || '.' || substr(code_digits, 7, 2)) STORED,
  description     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hs_code_uq UNIQUE (btki_version_id, code_digits)
);

-- ---------------------------------------------------------------- products

CREATE TABLE ecr.product (
  id                           uuid PRIMARY KEY DEFAULT uuidv7(),
  entity_id                    uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  valid_from                   date NOT NULL,
  valid_to                     date,
  version_from                 int NOT NULL REFERENCES ecr.data_version (version_no),
  version_to                   int REFERENCES ecr.data_version (version_no),
  change_set_id                uuid NOT NULL REFERENCES ecr.change_set (id),
  group_entity_id              uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  item_no_as_printed           text,
  name_id                      text NOT NULL,
  name_en                      text,
  synonyms                     text[] NOT NULL DEFAULT '{}',
  definition                   text,
  notes                        text[] NOT NULL DEFAULT '{}',
  annex_page                   int CHECK (annex_page > 0),
  classification_regulation_id uuid NOT NULL REFERENCES ecr.entity_key (entity_id),
  fx_on_peb_date               boolean NOT NULL DEFAULT false,
  other_obligations_note       text,
  created_at                   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_validity CHECK (valid_to IS NULL OR valid_to > valid_from),
  CONSTRAINT product_versions CHECK (version_to IS NULL OR version_to > version_from)
);
CREATE UNIQUE INDEX product_current_uq ON ecr.product (entity_id) WHERE version_to IS NULL;
CREATE INDEX product_entity_idx ON ecr.product (entity_id, version_from);
CREATE INDEX product_group_idx ON ecr.product (group_entity_id) WHERE version_to IS NULL;
CREATE TRIGGER product_guard BEFORE UPDATE OR DELETE ON ecr.product
FOR EACH ROW EXECUTE FUNCTION ecr.version_row_guard();

CREATE TABLE ecr.product_parameter (
  product_row_id uuid NOT NULL REFERENCES ecr.product (id),
  ordinal        int NOT NULL,
  name           text NOT NULL,
  operator       text NOT NULL CHECK (operator IN ('<', '≤', '=', '≥', '>', 'RANGE', 'TEXT')),
  value_text     text NOT NULL,
  value_min      numeric,
  value_max      numeric,
  unit           text,
  is_primary     boolean NOT NULL DEFAULT false,
  PRIMARY KEY (product_row_id, ordinal)
);
CREATE UNIQUE INDEX product_parameter_one_primary ON ecr.product_parameter (product_row_id) WHERE is_primary;
CREATE TRIGGER product_parameter_guard BEFORE UPDATE OR DELETE ON ecr.product_parameter
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();

CREATE TABLE ecr.product_hs_code (
  product_row_id uuid NOT NULL REFERENCES ecr.product (id),
  hs_code_id     uuid NOT NULL REFERENCES ecr.hs_code (id),
  is_ex          boolean NOT NULL DEFAULT false,
  ex_description text,
  PRIMARY KEY (product_row_id, hs_code_id),
  CONSTRAINT product_hs_code_ex CHECK (NOT is_ex OR length(btrim(coalesce(ex_description, ''))) > 0)
);
CREATE INDEX product_hs_code_hs_idx ON ecr.product_hs_code (hs_code_id);
CREATE TRIGGER product_hs_code_guard BEFORE UPDATE OR DELETE ON ecr.product_hs_code
FOR EACH ROW EXECUTE FUNCTION ecr.child_row_guard();

-- BR-PRD-04: shared tariff posts are computed, never entered. Pairs of current products on the same code.
CREATE VIEW ecr.v_shared_hs AS
SELECT a.entity_id AS product_entity_id, b.entity_id AS other_product_entity_id, ah.hs_code_id
  FROM ecr.product a
  JOIN ecr.product_hs_code ah ON ah.product_row_id = a.id
  JOIN ecr.product_hs_code bh ON bh.hs_code_id = ah.hs_code_id
  JOIN ecr.product b ON b.id = bh.product_row_id
 WHERE a.version_to IS NULL AND b.version_to IS NULL AND a.entity_id <> b.entity_id;
