import { Body, Controller, Get, HttpCode, Param, Post, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { sendFile } from '../exports/exports.controller';
import { entityParam } from '../registry/registry.controller';
import { ImportsService, UploadedFile as ImportFile } from './imports.service';
import { MAX_IMPORT_BYTES } from './template';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Technical Design §4.2.3 and §5.1 "Import": template, dry run, report, commit into a change set. */
@Controller('imports')
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  @Get('template')
  @Authorize({ permissions: ['import.run'] })
  async template(@Res() res: Response) {
    sendFile(res, { body: await this.imports.template(), filename: 'ecr-import-template.xlsx', contentType: XLSX });
  }

  /** Multipart: file (.xlsx ≤ 10 MB). 201 with the dry-run report; nothing is saved to the data. */
  @Post()
  @Authorize({ permissions: ['import.run'] })
  // A little above the limit, so the service answers with FILE_TOO_LARGE rather than the upload layer.
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_IMPORT_BYTES + 64 * 1024, files: 1, fields: 5 } }))
  upload(@UploadedFile() file: ImportFile | undefined, @Req() req: AuthorizedRequest) {
    return this.imports.upload(actorOf(req), file);
  }

  @Get()
  @Authorize({ permissions: ['import.run'] })
  list(@Req() req: AuthorizedRequest) {
    return this.imports.list(actorOf(req));
  }

  @Get(':id')
  @Authorize({ permissions: ['catalogue.read'] })
  get(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.imports.get(actorOf(req), entityParam(id, 'Import'));
  }

  @Get(':id/report')
  @Authorize({ permissions: ['catalogue.read'] })
  async report(@Param('id') id: string, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const { body, filename } = await this.imports.reportFile(actorOf(req), entityParam(id, 'Import'));
    sendFile(res, { body, filename, contentType: XLSX });
  }

  /** Body: { title?, justification?, acknowledgeWarnings? }. Creates one IMPORT change set (DRAFT). */
  @Post(':id/commit')
  @HttpCode(200)
  @Authorize({ permissions: ['import.run', 'changeset.create'] })
  commit(@Param('id') id: string, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.imports.commit(actorOf(req), entityParam(id, 'Import'), body);
  }
}
