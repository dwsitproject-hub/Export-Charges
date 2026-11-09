-- A sign-in that ECR restarted by itself after a callback it could not use (for example a launch from the DWS Hub
-- dashboard, where the Hub starts the authorization on its own). Such a sign-in is never restarted a second time.
ALTER TABLE ecr.oidc_login_state ADD COLUMN relaunch boolean NOT NULL DEFAULT false;
