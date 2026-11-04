-- Invitations and access requests are handled by DWS Hub, so ECR provisions accounts just-in-time
-- on first sign-in and keeps only role assignment. ECR TOTP covers step-up for privileged roles
-- until DWS Hub reports MFA (Technical Design T-01).

ALTER TABLE ecr.oidc_login_state DROP COLUMN invitation_id;
DROP TABLE ecr.invitation;

-- Technical Design §7.1 local_credential. Password columns stay for break-glass accounts (later slice).
CREATE TABLE ecr.local_credential (
  user_id              uuid PRIMARY KEY REFERENCES ecr.app_user (id),
  password_hash        text,
  password_history     text[] NOT NULL DEFAULT '{}',
  must_change_password boolean NOT NULL DEFAULT false,
  totp_secret_enc      bytea,
  totp_confirmed_at    timestamptz,
  totp_last_step       bigint,
  recovery_codes_hash  text[] NOT NULL DEFAULT '{}',
  failed_count         int NOT NULL DEFAULT 0,
  locked_until         timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT local_credential_confirm_needs_secret CHECK (totp_confirmed_at IS NULL OR totp_secret_enc IS NOT NULL)
);
