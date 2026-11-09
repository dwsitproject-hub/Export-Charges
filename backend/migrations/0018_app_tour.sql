-- The guided tour shown at a person's first sign-in: when they finished or closed it, so it is not shown again on
-- any browser. They can replay it at any time from the "Tour" button.
ALTER TABLE ecr.app_user ADD COLUMN tour_seen_at timestamptz;
