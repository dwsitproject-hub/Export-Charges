-- ECR PRD FR-SRC-03 and FR-SRC-04: the daily source watch. It reads the official publishers, never publishes anything,
-- and turns what it finds into items for Makers: a registered regulation amended or revoked at BPK, a new document on
-- an official listing (PMK, Kepmendag), a new file on a regulation's JDIH page, or a stored PDF that no longer matches
-- the official file. Each item has a fingerprint, so a finding is reported once however often the job runs.

CREATE TABLE ecr.source_watch_item (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  kind                 text NOT NULL CHECK (kind IN ('STATUS_CHANGE', 'NEW_DOCUMENT', 'NEW_FILE', 'FILE_CHANGED')),
  fingerprint          text NOT NULL UNIQUE,
  title                text NOT NULL,
  detail               text NOT NULL,
  url                  text NOT NULL,
  source               text NOT NULL,
  regulation_entity_id uuid REFERENCES ecr.entity_key (entity_id),
  source_document_id   uuid REFERENCES ecr.source_document (id),
  detected_at          timestamptz NOT NULL DEFAULT now(),
  run_id               uuid REFERENCES ecr.job_run (id),
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'DONE', 'DISMISSED')),
  resolved_by          uuid REFERENCES ecr.app_user (id),
  resolved_at          timestamptz,
  resolution_note      text,
  CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);
CREATE INDEX source_watch_item_open_idx ON ecr.source_watch_item (status, detected_at DESC);

-- Entries already seen on each listing. The first read of a listing only records what is there (its baseline);
-- later reads report what is new.
CREATE TABLE ecr.source_watch_seen (
  listing       text NOT NULL,
  url           text NOT NULL,
  title         text NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (listing, url)
);
