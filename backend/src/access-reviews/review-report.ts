import { MUTED, PdfLayout, WIDTH } from '../evidence/pdf-layout';
import { wibDateTime } from '../exports/present';

/** Everything the access review report prints; its canonical SHA-256 and signature are printed in every footer. */
export interface ReviewReportPayload {
  campaignId: string;
  periodLabel: string;
  startedAt: string;
  startedBy: string;
  dueAt: string;
  closedAt: string;
  closedBy: { name: string; email: string };
  totals: { items: number; kept: number; revoked: number; escalated: number };
  items: {
    user: string;
    email: string;
    userStatus: string;
    role: string;
    grantedAt: string;
    lastLoginAt: string | null;
    reviewerRole: string;
    decision: string;
    reason: string | null;
    reviewer: string;
    decidedAt: string;
    escalatedAt: string | null;
  }[];
}

const ROLE_TEXT: Record<string, string> = { USER_ADMIN: 'User Admin', SUPER_ADMIN: 'Super Admin' };

/** Lays the report out on A4 pages and returns the PDF/A-2b file. */
export function renderReviewReport(p: ReviewReportPayload, contentSha256: string, signature: string): Buffer {
  const out = new PdfLayout();
  out.title(`Access review ${p.periodLabel}`, p.campaignId,
    'Export Charges Registry (ECR) — periodic review of user roles (PRD F-12, L2-1.9)');

  out.facts([
    ['Period', p.periodLabel],
    ['Started', `${wibDateTime(p.startedAt)} by ${p.startedBy}`],
    ['Due', wibDateTime(p.dueAt)],
    ['Completed', `${wibDateTime(p.closedAt)}, last decision by ${p.closedBy.name} <${p.closedBy.email}>`],
    ['Assignments reviewed', `${p.totals.items}: ${p.totals.kept} kept, ${p.totals.revoked} revoked`],
    ['Escalated to Super Admins', `${p.totals.escalated} (not decided within 14 days)`],
  ]);

  out.heading('Decisions');
  out.table(
    [
      { title: 'User', width: 112 }, { title: 'Role', width: 56 }, { title: 'Last sign-in', width: 52 },
      { title: 'Decision', width: 42 }, { title: 'Reviewer (as)', width: 84 }, { title: 'Decided', width: 50 },
      { title: 'Reason', width: WIDTH - 396 },
    ],
    p.items.map((i) => [
      `${i.user}\n${i.email}${i.userStatus === 'ACTIVE' ? '' : `\n(${i.userStatus.toLowerCase().replace(/_/g, ' ')})`}`,
      i.role,
      i.lastLoginAt ? wibDateTime(i.lastLoginAt).slice(0, 10) : 'never',
      i.decision === 'KEEP' ? 'Keep' : 'Revoke',
      `${i.reviewer} (${ROLE_TEXT[i.reviewerRole] ?? i.reviewerRole})`,
      `${wibDateTime(i.decidedAt).slice(0, 10)}${i.escalatedAt ? '\nescalated' : ''}`,
      i.reason ?? '—',
    ]),
    7,
  );

  out.heading('Integrity');
  out.facts([
    ['Content SHA-256', contentSha256],
    ['Signature', signature],
  ]);
  out.paragraph('The content hash covers everything printed in this report. The signature is an HMAC-SHA256 of the content ' +
    'hash made with the ECR server key; ECR checks both, and the stored file, from the access review page.', 8, { color: MUTED });

  return out.finish(
    [`Access review ${p.periodLabel} · Content SHA-256 ${contentSha256}`, `Signature ${signature}`],
    {
      title: `ECR access review ${p.periodLabel}`,
      identifier: p.campaignId,
      description: `Content SHA-256 ${contentSha256}; signature ${signature}`,
      createdAt: new Date(p.closedAt),
    },
  );
}
