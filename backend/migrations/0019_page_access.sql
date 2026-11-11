-- Page access by role (Users → Roles and access). Look-up pages that used to share one permission (catalogue.read)
-- get their own view permission, so a Super Admin can open or close each page for each role. The published data
-- itself stays readable through catalogue.read, which a role keeps while it can view at least one look-up page.
-- Every role keeps exactly the pages it could open before this migration.

INSERT INTO ecr.permission (code, description, sod_group) VALUES
  ('page.catalogue',      'Open the Full product table', NULL),
  ('page.find',           'Open Find a product', NULL),
  ('page.policy_history', 'Open Policy History', NULL),
  ('page.regulations',    'Open Regulations', NULL),
  ('page.products',       'Open the Product list and product details', NULL),
  ('page.schedules',      'Open Rate tables', NULL),
  ('page.prices',         'Open Reference prices', NULL),
  ('page.sources',        'Open Official documents', NULL),
  ('page.source_watch',   'Open New regulation watch', NULL),
  ('page.audit',          'Open the Audit log', NULL),
  ('page.jobs',           'Open Background jobs', NULL);

-- Look-up pages: every role that could read the catalogue.
INSERT INTO ecr.role_permission (role_id, permission_code)
SELECT rp.role_id, p.code
  FROM ecr.role_permission rp
  CROSS JOIN (VALUES ('page.catalogue'), ('page.find'), ('page.policy_history'), ('page.regulations'), ('page.products'),
                     ('page.schedules'), ('page.prices'), ('page.sources')) AS p(code)
 WHERE rp.permission_code = 'catalogue.read'
ON CONFLICT DO NOTHING;

-- New regulation watch: every role that could read change sets.
INSERT INTO ecr.role_permission (role_id, permission_code)
SELECT rp.role_id, 'page.source_watch' FROM ecr.role_permission rp WHERE rp.permission_code = 'changeset.read'
ON CONFLICT DO NOTHING;

-- Audit log and Background jobs: every role that could read the audit log.
INSERT INTO ecr.role_permission (role_id, permission_code)
SELECT rp.role_id, p.code
  FROM ecr.role_permission rp CROSS JOIN (VALUES ('page.audit'), ('page.jobs')) AS p(code)
 WHERE rp.permission_code = 'audit.read'
ON CONFLICT DO NOTHING;
