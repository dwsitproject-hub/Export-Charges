import { Body, Controller, Get, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { catalogueQuery } from '../catalogue/catalogue.controller';
import { ApiError } from '../common/api-error';
import { entityParam } from '../registry/registry.controller';
import { ExportJobsService } from './export-jobs.service';
import { ExportFile, ExportsService, Format, FORMATS } from './exports.service';

function formatOf(v: string | undefined): Format {
  if (!FORMATS.includes(v as Format)) throw new ApiError(400, 'INVALID_INPUT', 'format must be csv or xlsx.');
  return v as Format;
}

export function sendFile(res: Response, file: ExportFile) {
  res.set({
    'Content-Type': file.contentType,
    'Content-Length': String(file.body.length),
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  });
  res.end(file.body);
}

/** Technical Design §4.3.3 and §5.1 "Export": CSV/XLSX under the export permission (US-47-N1 AC1). */
@Controller('exports')
export class ExportsController {
  constructor(
    private readonly exports: ExportsService,
    private readonly jobs: ExportJobsService,
  ) {}

  /** Same parameters as GET /api/catalogue plus format=csv|xlsx; all matching rows, ignoring paging. */
  @Get('catalogue')
  @Authorize({ permissions: ['export.run'] })
  async catalogue(@Query() q: Record<string, string | undefined>, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const format = formatOf(q.format);
    sendFile(res, await this.exports.catalogueExport(actorOf(req), catalogueQuery(q), format));
  }

  @Get('calculations/:id')
  @Authorize({ permissions: ['export.run'] })
  async calculation(@Param('id') id: string, @Query('format') format: string | undefined, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const f = formatOf(format);
    sendFile(res, await this.exports.calculationExport(actorOf(req), entityParam(id, 'Calculation'), f));
  }

  /**
   * US-47-N1 AC3: a catalogue export above the synchronous limit. Body: { format, query } with the catalogue's query
   * parameters. 201 with the queued job; the requester is notified when the file is ready.
   */
  @Post('jobs')
  @Authorize({ permissions: ['export.run'] })
  requestJob(@Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.jobs.request(actorOf(req), body);
  }

  @Get('jobs')
  @Authorize({ permissions: ['export.run'] })
  listJobs(@Req() req: AuthorizedRequest) {
    return this.jobs.list(req.ecr!.user.id);
  }

  @Get('jobs/:id')
  @Authorize({ permissions: ['export.run'] })
  getJob(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.jobs.get(req.ecr!.user.id, entityParam(id, 'Export'));
  }

  /** The requester only, for 24 hours (410 EXPORT_EXPIRED afterwards). */
  @Get('jobs/:id/file')
  @Authorize({ permissions: ['export.run'] })
  async jobFile(@Param('id') id: string, @Req() req: AuthorizedRequest, @Res() res: Response) {
    sendFile(res, await this.jobs.file(actorOf(req), entityParam(id, 'Export')));
  }
}
