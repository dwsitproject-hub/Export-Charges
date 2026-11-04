-- Built-in roles and permissions (PRD §8 permission matrix, Technical Design §5).
-- Super Admin data permissions are intentionally absent: they are break-glass grants.

INSERT INTO ecr.permission (code, description, sod_group) VALUES
  ('catalogue.read',     'View published catalogue, product detail, regulations and reference data', NULL),
  ('calc.run',           'Run and save charge calculations', NULL),
  ('export.run',         'Export lists and calculations to CSV/XLSX', NULL),
  ('evidence.create',    'Generate PDF/A evidence packs', NULL),
  ('changeset.read',     'View drafts, change sets and data versions', NULL),
  ('changeset.create',   'Create and edit change sets', 'SOD_MAKER_CHECKER'),
  ('changeset.submit',   'Submit and withdraw own change sets', NULL),
  ('changeset.approve',  'Approve, reject, publish and roll back change sets', 'SOD_MAKER_CHECKER'),
  ('source.upload',      'Upload official source documents', NULL),
  ('import.run',         'Run Excel bulk imports', NULL),
  ('dq.read',            'View data-quality findings', NULL),
  ('user.manage',        'Manage users, sessions and access reviews', NULL),
  ('user.invite',        'Invite users to non-admin roles', NULL),
  ('user.invite_admin',  'Invite or approve USER_ADMIN and SUPER_ADMIN', NULL),
  ('accessreq.approve',  'Approve or reject access requests', NULL),
  ('role.manage',        'Manage role definitions and permissions', NULL),
  ('audit.read',         'Search the audit log', NULL),
  ('audit.export',       'Export the audit log', NULL),
  ('config.manage',      'Change system configuration', NULL);

INSERT INTO ecr.role (code, name, description, is_builtin, is_privileged) VALUES
  ('VIEWER',      'Viewer',      'Read, search, calculate, export',                 true, false),
  ('MAKER',       'Maker',       'Prepare data changes and imports',                true, true),
  ('CHECKER',     'Checker',     'Review, approve, publish and roll back changes',  true, true),
  ('USER_ADMIN',  'User Admin',  'Manage users and non-admin role assignment',      true, true),
  ('AUDITOR',     'Auditor',     'Read-only access to audit log and versions',      true, true),
  ('SUPER_ADMIN', 'Super Admin', 'System administration',                           true, true);

INSERT INTO ecr.role_permission (role_id, permission_code)
SELECT r.id, p.code
FROM ecr.role r
JOIN (VALUES
  ('VIEWER', 'catalogue.read'), ('VIEWER', 'calc.run'), ('VIEWER', 'export.run'), ('VIEWER', 'evidence.create'),

  ('MAKER', 'catalogue.read'), ('MAKER', 'calc.run'), ('MAKER', 'export.run'), ('MAKER', 'evidence.create'),
  ('MAKER', 'changeset.read'), ('MAKER', 'changeset.create'), ('MAKER', 'changeset.submit'),
  ('MAKER', 'source.upload'), ('MAKER', 'import.run'), ('MAKER', 'dq.read'),

  ('CHECKER', 'catalogue.read'), ('CHECKER', 'calc.run'), ('CHECKER', 'export.run'), ('CHECKER', 'evidence.create'),
  ('CHECKER', 'changeset.read'), ('CHECKER', 'changeset.approve'), ('CHECKER', 'dq.read'),

  ('USER_ADMIN', 'catalogue.read'), ('USER_ADMIN', 'calc.run'), ('USER_ADMIN', 'export.run'), ('USER_ADMIN', 'evidence.create'),
  ('USER_ADMIN', 'user.manage'), ('USER_ADMIN', 'user.invite'), ('USER_ADMIN', 'accessreq.approve'),

  ('AUDITOR', 'catalogue.read'), ('AUDITOR', 'calc.run'), ('AUDITOR', 'export.run'), ('AUDITOR', 'evidence.create'),
  ('AUDITOR', 'changeset.read'), ('AUDITOR', 'dq.read'), ('AUDITOR', 'audit.read'), ('AUDITOR', 'audit.export'),

  ('SUPER_ADMIN', 'catalogue.read'), ('SUPER_ADMIN', 'calc.run'), ('SUPER_ADMIN', 'export.run'), ('SUPER_ADMIN', 'evidence.create'),
  ('SUPER_ADMIN', 'changeset.read'), ('SUPER_ADMIN', 'user.manage'), ('SUPER_ADMIN', 'user.invite'),
  ('SUPER_ADMIN', 'user.invite_admin'), ('SUPER_ADMIN', 'accessreq.approve'), ('SUPER_ADMIN', 'role.manage'),
  ('SUPER_ADMIN', 'audit.read'), ('SUPER_ADMIN', 'audit.export'), ('SUPER_ADMIN', 'config.manage')
) AS m(role_code, permission_code) ON m.role_code = r.code
JOIN ecr.permission p ON p.code = m.permission_code;
