import { Body, Controller, Get, Param, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { entityParam } from './registry.controller';
import { MAX_SOURCE_BYTES, SourceDocumentsService, UploadedFile as SourceFile } from './source-documents.service';

/** Technical Design §4.2.2 and §5.1 "Sources". */
@Controller()
export class SourceDocumentsController {
  constructor(private readonly docs: SourceDocumentsService) {}

  /** Multipart: file (PDF ≤ 25 MB) plus docKind, title, docNumber, docDate, officialUrl, isSecondary. */
  @Post('source-documents')
  @Authorize({ permissions: ['source.upload'] })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_SOURCE_BYTES, files: 1, fields: 20 } }))
  upload(@UploadedFile() file: SourceFile | undefined, @Body() body: unknown, @Req() req: AuthorizedRequest) {
    return this.docs.upload(actorOf(req), file, body);
  }

  @Get('source-documents')
  @Authorize({ permissions: ['catalogue.read'] })
  list(@Query('q') q: string | undefined, @Req() req: AuthorizedRequest) {
    return this.docs.list(q?.slice(0, 100) || undefined, req.access!.permissions.has('changeset.read'));
  }

  @Get('source-documents/:id')
  @Authorize({ permissions: ['catalogue.read'] })
  get(@Param('id') id: string, @Req() req: AuthorizedRequest) {
    return this.docs.get(entityParam(id, 'Document'), req.access!.permissions.has('changeset.read'));
  }

  @Get('source-documents/:id/file')
  @Authorize({ permissions: ['catalogue.read'] })
  async file(@Param('id') id: string, @Query('download') download: string | undefined, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const { body, filename } = await this.docs.file(entityParam(id, 'Document'), req.access!.permissions.has('changeset.read'));
    // Opens in the browser's PDF viewer unless ?download=1 asks to save it.
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(body.length),
      'Content-Disposition': `${download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename.replace(/[\r\n"]/g, ''))}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    res.end(body);
  }

  @Get('source-publishers')
  @Authorize({ permissions: ['catalogue.read'] })
  publishers() {
    return this.docs.publishers();
  }
}
