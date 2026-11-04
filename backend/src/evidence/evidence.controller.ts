import { Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { ApiError } from '../common/api-error';
import { sendFile } from '../exports/exports.controller';
import { entityParam } from '../registry/registry.controller';
import { EVIDENCE_ID_RE, EvidenceService } from './evidence.service';

function evidenceParam(id: string): string {
  const normal = `EV-${id.replace(/^ev-/i, '').toLowerCase()}`;
  if (!EVIDENCE_ID_RE.test(normal)) throw new ApiError(404, 'NOT_FOUND', 'Evidence pack not found.');
  return normal;
}

/** Technical Design §4.3.3 and §5.1 "Evidence". */
@Controller()
export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  /** 201 with the new pack, or 200 with the pack already made for this calculation. */
  @Post('calculations/:id/evidence')
  @Authorize({ permissions: ['evidence.create'] })
  async create(@Param('id') id: string, @Req() req: AuthorizedRequest, @Res({ passthrough: true }) res: Response) {
    const { created, pack } = await this.evidence.create(actorOf(req), entityParam(id, 'Calculation'));
    res.status(created ? 201 : 200);
    return { ...pack, created };
  }

  @Get('evidence/:evidenceId')
  @Authorize({ permissions: ['catalogue.read'] })
  get(@Param('evidenceId') id: string, @Req() req: AuthorizedRequest) {
    return this.evidence.get(actorOf(req), evidenceParam(id));
  }

  @Get('evidence/:evidenceId/file')
  @Authorize({ permissions: ['catalogue.read'] })
  async file(@Param('evidenceId') id: string, @Req() req: AuthorizedRequest, @Res() res: Response) {
    const { body, filename } = await this.evidence.file(actorOf(req), evidenceParam(id));
    sendFile(res, { body, filename, contentType: 'application/pdf' });
  }

  /** Any signed-in user holding a pack can check it (the URL printed in its footer opens the web page that calls this). */
  @Get('evidence/:evidenceId/verify')
  @Authorize({ permissions: ['catalogue.read'] })
  verify(@Param('evidenceId') id: string, @Req() req: AuthorizedRequest) {
    return this.evidence.verify(actorOf(req), evidenceParam(id));
  }
}
