import { Injectable } from '@nestjs/common';
import type { Actor } from '../auth/actor';
import { AuditService } from '../audit/audit.service';
import { ApiError } from '../common/api-error';
import { DbService } from '../db/db.service';

/**
 * Page access by role (Users → Roles and access). Each page or menu entry has a few access levels; each level is a
 * set of permissions. A role's permissions are the union of the levels chosen for it, plus the permissions no page
 * manages (e.g. inviting administrators). Look-up pages each have their own `page.*` permission, so they open and
 * close independently; the published data behind them stays readable through `catalogue.read`, which a role keeps
 * while it can view at least one of them. Actions that change data stay guarded by their own permissions.
 */

export interface AccessLevel {
  key: string;
  label: string;
  permissions: string[];
}

export interface PageDef {
  key: string;
  label: string;
  group: string;
  hint: string;
  /** Ordered from no access to the most access; the first is always NONE. */
  levels: AccessLevel[];
}

const NONE: AccessLevel = { key: 'NONE', label: 'No access', permissions: [] };
const view = (page: string, label = 'View'): AccessLevel => ({ key: 'VIEW', label, permissions: [page, 'catalogue.read'] });

export const PAGES: PageDef[] = [
  { key: 'catalogue', group: 'Look things up', label: 'Full product table', hint: 'The landing page: every product with its duty and levy', levels: [NONE, view('page.catalogue')] },
  { key: 'find', group: 'Look things up', label: 'Find a product', hint: 'One product, in plain words', levels: [NONE, view('page.find')] },
  {
    key: 'calculator', group: 'Look things up', label: 'Calculate a shipment', hint: 'Shipment totals in USD and Rupiah, saved calculations',
    levels: [NONE, { key: 'VIEW', label: 'Calculate', permissions: ['calc.run'] }, { key: 'EDIT', label: 'Calculate + evidence', permissions: ['calc.run', 'evidence.create'] }],
  },
  { key: 'policy_history', group: 'Look things up', label: 'Policy History', hint: 'Regulations, reference prices and data updates over time', levels: [NONE, view('page.policy_history')] },
  { key: 'regulations', group: 'Look things up', label: 'Regulations', hint: 'The decrees behind the rates', levels: [NONE, view('page.regulations')] },
  { key: 'products', group: 'Look things up', label: 'Product list', hint: 'Products and their details', levels: [NONE, view('page.products')] },
  { key: 'schedules', group: 'Look things up', label: 'Rate tables', hint: 'Duty and levy by price band', levels: [NONE, view('page.schedules')] },
  { key: 'prices', group: 'Look things up', label: 'Reference prices', hint: 'CPO price and KMK rate', levels: [NONE, view('page.prices')] },
  {
    key: 'sources', group: 'Look things up', label: 'Official documents', hint: 'The official PDFs',
    levels: [NONE, view('page.sources'), { key: 'EDIT', label: 'View + upload', permissions: ['page.sources', 'catalogue.read', 'source.upload'] }],
  },
  { key: 'exports', group: 'Look things up', label: 'Downloads (Excel / CSV)', hint: 'Export buttons and My downloads', levels: [NONE, { key: 'EDIT', label: 'Use', permissions: ['export.run'] }] },
  {
    key: 'changesets', group: 'Update the data', label: 'Rate updates', hint: 'Change sets: enter, review and approve changes',
    levels: [
      NONE,
      { key: 'VIEW', label: 'View', permissions: ['changeset.read'] },
      { key: 'ENTER', label: 'Enter (Maker)', permissions: ['changeset.read', 'changeset.create', 'changeset.submit'] },
      { key: 'APPROVE', label: 'Approve (Checker)', permissions: ['changeset.read', 'changeset.approve'] },
    ],
  },
  { key: 'imports', group: 'Update the data', label: 'Import a file', hint: 'Excel imports (needs Rate updates: Enter)', levels: [NONE, { key: 'EDIT', label: 'Use', permissions: ['import.run'] }] },
  { key: 'data_quality', group: 'Update the data', label: 'Data checks', hint: 'Data-quality findings', levels: [NONE, { key: 'VIEW', label: 'View', permissions: ['dq.read'] }] },
  { key: 'source_watch', group: 'Update the data', label: 'New regulation watch', hint: 'What ECR found on the official sites', levels: [NONE, { key: 'VIEW', label: 'View', permissions: ['page.source_watch', 'changeset.read'] }] },
  { key: 'users', group: 'Administration', label: 'Users', hint: 'People, roles and this page', levels: [NONE, { key: 'EDIT', label: 'Manage', permissions: ['user.manage', 'user.invite'] }] },
  { key: 'access_reviews', group: 'Administration', label: 'Access reviews', hint: 'Quarterly reviews of who keeps access', levels: [NONE, { key: 'VIEW', label: 'View', permissions: ['accessreview.read'] }] },
  {
    key: 'audit', group: 'Administration', label: 'Audit log', hint: 'Who did what, when',
    levels: [NONE, { key: 'VIEW', label: 'View', permissions: ['page.audit', 'audit.read'] }, { key: 'EDIT', label: 'View + export', permissions: ['page.audit', 'audit.read', 'audit.export'] }],
  },
  { key: 'jobs', group: 'Administration', label: 'Background jobs', hint: 'Scheduled jobs and their runs', levels: [NONE, { key: 'VIEW', label: 'View', permissions: ['page.jobs', 'audit.read'] }] },
  { key: 'settings', group: 'Administration', label: 'Settings', hint: 'System configuration (also Run now on jobs)', levels: [NONE, { key: 'EDIT', label: 'Manage', permissions: ['config.manage'] }] },
];

/** Settings a Super Admin always keeps, so the system can never be locked out of its own administration. */
const LOCKED: Record<string, Record<string, string>> = { SUPER_ADMIN: { users: 'EDIT', settings: 'EDIT' } };

const MANAGED = new Set(PAGES.flatMap((p) => p.levels.flatMap((l) => l.permissions)));

/** The level a set of permissions amounts to for a page: the most access it fully holds. */
function levelOf(page: PageDef, held: Set<string>): string {
  let best = 'NONE';
  for (const l of page.levels) if (l.permissions.length && l.permissions.every((p) => held.has(p))) best = l.key;
  return best;
}

@Injectable()
export class PageAccessService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  /** The pages, the roles and each role's current level per page. */
  async matrix() {
    const { rows } = await this.db.query<{ code: string; name: string; permissions: string[] }>(
      `SELECT r.code, r.name, COALESCE(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
         FROM ecr.role r LEFT JOIN ecr.role_permission rp ON rp.role_id = r.id
        GROUP BY r.id ORDER BY array_position(ARRAY['VIEWER','MAKER','CHECKER','USER_ADMIN','AUDITOR','SUPER_ADMIN'], r.code), r.code`,
    );
    return {
      pages: PAGES.map(({ key, label, group, hint, levels }) => ({ key, label, group, hint, levels: levels.map(({ key: k, label: l }) => ({ key: k, label: l })) })),
      roles: rows.map((r) => {
        const held = new Set(r.permissions);
        return { code: r.code, name: r.name, access: Object.fromEntries(PAGES.map((p) => [p.key, levelOf(p, held)])), locked: LOCKED[r.code] ?? {} };
      }),
    };
  }

  /** Sets one role's level for the pages given (others keep theirs). Takes effect at the role's next request. */
  async save(actor: Actor, roleCode: string, input: Record<string, unknown>) {
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 3) throw new ApiError(400, 'INVALID_INPUT', 'A reason of at least 3 characters is required.');
    const wanted = input.access && typeof input.access === 'object' ? (input.access as Record<string, unknown>) : {};
    const code = roleCode.toUpperCase();

    return this.db.tx(async (c) => {
      const { rows: [role] } = await c.query<{ id: string; code: string }>('SELECT id, code FROM ecr.role WHERE code = $1 FOR UPDATE', [code]);
      if (!role) throw new ApiError(404, 'NOT_FOUND', 'Role not found.');
      const { rows: perms } = await c.query<{ permission_code: string }>('SELECT permission_code FROM ecr.role_permission WHERE role_id = $1', [role.id]);
      const held = new Set(perms.map((p) => p.permission_code));
      const before = Object.fromEntries(PAGES.map((p) => [p.key, levelOf(p, held)]));
      const after = { ...before };
      for (const [pageKey, level] of Object.entries(wanted)) {
        const page = PAGES.find((p) => p.key === pageKey);
        if (!page) throw new ApiError(400, 'INVALID_INPUT', `Unknown page ${pageKey}.`);
        if (typeof level !== 'string' || !page.levels.some((l) => l.key === level)) throw new ApiError(400, 'INVALID_INPUT', `${page.label}: unknown access level.`);
        after[pageKey] = level;
      }
      for (const [pageKey, level] of Object.entries(LOCKED[code] ?? {})) {
        if (after[pageKey] !== level) {
          throw new ApiError(422, 'ACCESS_LOCKED', `${code === 'SUPER_ADMIN' ? 'Super Admins' : code} always keep ${PAGES.find((p) => p.key === pageKey)!.label}: Manage, so ECR can never be locked out of its administration.`);
        }
      }
      // SoD-2: a User Admin never prepares or approves data changes.
      if (code === 'USER_ADMIN' && (after.changesets === 'ENTER' || after.changesets === 'APPROVE')) {
        throw new ApiError(422, 'SOD_CONFLICT', 'User Admins cannot enter or approve rate updates (SoD-2).');
      }

      const next = new Set([...held].filter((p) => !MANAGED.has(p)));
      for (const page of PAGES) for (const p of page.levels.find((l) => l.key === after[page.key])!.permissions) next.add(p);
      const removed = [...held].filter((p) => !next.has(p)).sort();
      const added = [...next].filter((p) => !held.has(p)).sort();
      const changed = PAGES.filter((p) => before[p.key] !== after[p.key]).map((p) => p.key);
      if (!changed.length && !removed.length && !added.length) return { role: code, changed: [] as string[] };

      if (removed.length) await c.query('DELETE FROM ecr.role_permission WHERE role_id = $1 AND permission_code = ANY($2)', [role.id, removed]);
      if (added.length) await c.query('INSERT INTO ecr.role_permission (role_id, permission_code) SELECT $1, unnest($2::text[])', [role.id, added]);
      await this.audit.record(c, {
        action: 'ROLE_ACCESS_CHANGED', actorKind: 'USER', actorUserId: actor.id, sessionId: actor.sessionId, ip: actor.ip, userAgent: actor.userAgent,
        entityType: 'ROLE', entityId: code, reason,
        before: Object.fromEntries(changed.map((k) => [k, before[k]])),
        after: { ...Object.fromEntries(changed.map((k) => [k, after[k]])), added, removed },
      });
      return { role: code, changed };
    });
  }
}
