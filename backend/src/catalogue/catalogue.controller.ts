import { Controller, Get, Query } from '@nestjs/common';
import { Authorize } from '../auth/authorize';
import { isDate, UUID_RE, wibToday } from '../common/fields';
import { CATEGORIES, CatalogueQuery, CatalogueService, SORTS } from './catalogue.service';

const list = (v: string | undefined, ok: (s: string) => boolean) => (v ?? '').split(',').map((s) => s.trim()).filter((s) => s && ok(s));

/** Query parameters of the catalogue and its export; unknown values are ignored. */
export function catalogueQuery(q: Record<string, string | undefined>): CatalogueQuery {
  const version = Number(q.version);
  return {
    date: q.date && isDate(q.date) ? q.date : wibToday(),
    versionNo: Number.isInteger(version) && version > 0 ? version : undefined,
    q: q.q,
    commodity: list(q.commodity, (s) => UUID_RE.test(s)),
    group: list(q.group, (s) => UUID_RE.test(s)),
    category: list(q.category, (s) => CATEGORIES.includes(s as never)),
    regulation: list(q.regulation, (s) => UUID_RE.test(s)),
    sharedHs: q.sharedHs === 'true',
    sort: SORTS.includes(q.sort as never) ? (q.sort as (typeof SORTS)[number]) : 'default',
    dir: q.dir === 'desc' ? 'desc' : 'asc',
    page: Math.max(Number(q.page) || 1, 1),
    pageSize: Math.min(Math.max(Number(q.pageSize) || 50, 1), 200),
  };
}

/**
 * GET /api/catalogue?q=&date=&version=&commodity=&group=&category=&regulation=&sharedHs=&sort=&dir=&page=&pageSize=
 * Multi-select filters are comma-separated. Dates are WIB business dates (the PEB date).
 */
@Controller('catalogue')
export class CatalogueController {
  constructor(private readonly catalogue: CatalogueService) {}

  @Get()
  @Authorize({ permissions: ['catalogue.read'] })
  get(@Query() q: Record<string, string | undefined>) {
    return this.catalogue.catalogue(catalogueQuery(q));
  }
}
