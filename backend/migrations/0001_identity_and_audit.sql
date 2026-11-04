-- ECR Technical Design §7.1 (identity and access) and §7.3 (audit trail).
-- Requires PostgreSQL 18 (uuidv7()).

CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS ecr;

-- ---------------------------------------------------------------- users

CREATE TABLE ecr.app_user (
  id                 uuid PRIMARY KEY DEFAULT uuidv7(),
  email              citext NOT NULL UNIQUE,
  full_name          text NOT NULL,
  department         text,
  status             text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'LOCKED', 'DEACTIVATED', 'EXPIRED', 'DORMANT_DISABLED')),
  access_expires_at  timestamptz,
  last_login_at      timestamptz,
  is_break_glass     boolean NOT NULL DEFAULT false,
  deactivated_reason text,
  pseudonymised_at   timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT app_user_deactivated_reason CHECK (status <> 'DEACTIVATED' OR deactivated_reason IS NOT NULL)
);
CREATE INDEX app_user_status_idx ON ecr.app_user (status);
CREATE INDEX app_user_last_login_idx ON ecr.app_user (last_login_at);

CREATE TABLE ecr.user_identity (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id       uuid NOT NULL REFERENCES ecr.app_user (id),
  provider      text NOT NULL CHECK (provider IN ('DWS_HUB', 'LOCAL')),
  subject       text NOT NULL,
  issuer        text NOT NULL,
  email_at_link citext NOT NULL,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_identity_provider_subject_uq UNIQUE (provider, subject)
);
CREATE INDEX user_identity_user_idx ON ecr.user_identity (user_id);

-- ---------------------------------------------------------------- RBAC

CREATE TABLE ecr.role (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  description   text,
  is_builtin    boolean NOT NULL DEFAULT false,
  is_privileged boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ecr.permission (
  code        text PRIMARY KEY,
  description text NOT NULL,
  sod_group   text
);

CREATE TABLE ecr.role_permission (
  role_id         uuid NOT NULL REFERENCES ecr.role (id),
  permission_code text NOT NULL REFERENCES ecr.permission (code),
  PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE ecr.user_role (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  user_id    uuid NOT NULL REFERENCES ecr.app_user (id),
  role_id    uuid NOT NULL REFERENCES ecr.role (id),
  granted_by uuid REFERENCES ecr.app_user (id), -- NULL = granted by the system (bootstrap or seed)
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES ecr.app_user (id),
  CONSTRAINT user_role_not_self_granted CHECK (granted_by IS NULL OR granted_by <> user_id) -- SoD-3
);
CREATE UNIQUE INDEX user_role_live_uq ON ecr.user_role (user_id, role_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------- invitations

CREATE TABLE ecr.invitation (
  id                uuid PRIMARY KEY DEFAULT uuidv7(),
  email             citext NOT NULL,
  full_name         text NOT NULL,
  department        text,
  role_ids          uuid[] NOT NULL,
  access_expires_at timestamptz,
  token_hash        bytea NOT NULL UNIQUE,
  status            text NOT NULL CHECK (status IN ('INVITED', 'ACCEPTED', 'EXPIRED', 'REVOKED')),
  expires_at        timestamptz NOT NULL,
  invited_by        uuid REFERENCES ecr.app_user (id), -- NULL = system seed
  accepted_user_id  uuid REFERENCES ecr.app_user (id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX invitation_open_email_uq ON ecr.invitation (email) WHERE status = 'INVITED';

-- ---------------------------------------------------------------- sign-in and sessions

CREATE TABLE ecr.oidc_login_state (
  state_hash           bytea PRIMARY KEY,
  browser_binding_hash bytea NOT NULL,
  nonce                text NOT NULL,
  code_verifier_enc    bytea NOT NULL,
  return_to            text NOT NULL,
  invitation_id        uuid REFERENCES ecr.invitation (id),
  purpose              text NOT NULL CHECK (purpose IN ('LOGIN', 'STEP_UP')),
  expires_at           timestamptz NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oidc_login_state_expires_idx ON ecr.oidc_login_state (expires_at);

CREATE TABLE ecr.user_session (
  id                   uuid PRIMARY KEY DEFAULT uuidv7(),
  token_hash           bytea NOT NULL UNIQUE,
  user_id              uuid NOT NULL REFERENCES ecr.app_user (id),
  auth_method          text NOT NULL CHECK (auth_method IN ('DWS_HUB', 'LOCAL')),
  id_token_hash        bytea,
  csrf_token           text NOT NULL,
  idle_timeout_minutes int NOT NULL CHECK (idle_timeout_minutes BETWEEN 1 AND 60),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at  timestamptz NOT NULL,
  stepped_up_at        timestamptz,
  ip                   inet,
  user_agent           text,
  revoked_at           timestamptz,
  revoke_reason        text CHECK (revoke_reason IN ('LOGOUT', 'LOGOUT_ALL', 'EXPIRED', 'SESSION_LIMIT', 'ADMIN_REVOKE', 'USER_INACTIVE')),
  CONSTRAINT user_session_revoked_reason CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE INDEX user_session_live_user_idx ON ecr.user_session (user_id) WHERE revoked_at IS NULL;
CREATE INDEX user_session_absolute_idx ON ecr.user_session (absolute_expires_at);

-- ---------------------------------------------------------------- audit trail (append-only, hash-chained)

CREATE TABLE ecr.audit_chain_head (
  id        smallint PRIMARY KEY CHECK (id = 1),
  last_seq  bigint NOT NULL,
  last_hash bytea NOT NULL
);
INSERT INTO ecr.audit_chain_head (id, last_seq, last_hash)
VALUES (1, 0, sha256(convert_to('ECR-AUDIT-GENESIS', 'UTF8')));

CREATE TABLE ecr.audit_event (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  chain_seq     bigint NOT NULL UNIQUE,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_kind    text NOT NULL CHECK (actor_kind IN ('USER', 'SYSTEM', 'ANONYMOUS')),
  actor_user_id uuid REFERENCES ecr.app_user (id),
  session_id    uuid,
  ip            inet,
  user_agent    text,
  action        text NOT NULL,
  entity_type   text,
  entity_id     text,
  before        jsonb,
  after         jsonb,
  reason        text,
  prev_hash     bytea NOT NULL,
  hash          bytea NOT NULL
);
CREATE INDEX audit_event_occurred_idx ON ecr.audit_event (occurred_at);
CREATE INDEX audit_event_actor_idx ON ecr.audit_event (actor_user_id, occurred_at);
CREATE INDEX audit_event_action_idx ON ecr.audit_event (action, occurred_at);

-- Canonical text of an event; the hash chain and the verifier must use the same function.
CREATE FUNCTION ecr.audit_event_canonical(e ecr.audit_event) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'chain_seq', e.chain_seq,
    'occurred_at', to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_kind', e.actor_kind,
    'actor_user_id', e.actor_user_id,
    'session_id', e.session_id,
    'ip', host(e.ip),
    'user_agent', e.user_agent,
    'action', e.action,
    'entity_type', e.entity_type,
    'entity_id', e.entity_id,
    'before', e.before,
    'after', e.after,
    'reason', e.reason
  )::text
$$;

-- Serialises inserts on the single head row and links each event to the previous one.
CREATE FUNCTION ecr.audit_event_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head ecr.audit_chain_head%ROWTYPE;
BEGIN
  SELECT * INTO head FROM ecr.audit_chain_head WHERE id = 1 FOR UPDATE;
  NEW.chain_seq := head.last_seq + 1;
  NEW.prev_hash := head.last_hash;
  NEW.hash := sha256(head.last_hash || convert_to(ecr.audit_event_canonical(NEW), 'UTF8'));
  UPDATE ecr.audit_chain_head SET last_seq = NEW.chain_seq, last_hash = NEW.hash WHERE id = 1;
  RETURN NEW;
END
$$;

CREATE TRIGGER audit_event_chain_trg
BEFORE INSERT ON ecr.audit_event
FOR EACH ROW EXECUTE FUNCTION ecr.audit_event_chain();

CREATE FUNCTION ecr.audit_event_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_event is append-only (% refused)', TG_OP;
END
$$;

CREATE TRIGGER audit_event_no_update_delete
BEFORE UPDATE OR DELETE ON ecr.audit_event
FOR EACH ROW EXECUTE FUNCTION ecr.audit_event_immutable();

CREATE TRIGGER audit_event_no_truncate
BEFORE TRUNCATE ON ecr.audit_event
FOR EACH STATEMENT EXECUTE FUNCTION ecr.audit_event_immutable();

-- Returns the chain_seq of the first broken link, or NULL when the whole chain verifies.
CREATE FUNCTION ecr.audit_chain_verify() RETURNS bigint
LANGUAGE plpgsql STABLE AS $$
DECLARE
  e    ecr.audit_event%ROWTYPE;
  prev bytea := sha256(convert_to('ECR-AUDIT-GENESIS', 'UTF8'));
BEGIN
  FOR e IN SELECT * FROM ecr.audit_event ORDER BY chain_seq LOOP
    IF e.prev_hash <> prev
       OR e.hash <> sha256(prev || convert_to(ecr.audit_event_canonical(e), 'UTF8')) THEN
      RETURN e.chain_seq;
    END IF;
    prev := e.hash;
  END LOOP;
  RETURN NULL;
END
$$;
