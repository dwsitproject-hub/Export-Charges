import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiError } from '../common/api-error';
import { clientIp } from '../common/http';
import { DbService } from '../db/db.service';
import { EcrRequest, SessionGuard } from './session.guard';
import { TotpService } from './totp.service';

function ctxOf(req: EcrRequest) {
  return { sessionId: req.ecr!.session.id, ip: clientIp(req), userAgent: req.get('user-agent') };
}

function codeFrom(body: unknown, key: 'code' | 'recoveryCode'): string | undefined {
  const value = (body as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Authenticator enrolment and step-up (Technical Design §4.1.6). Responses are never cached. */
@Controller('auth')
@UseGuards(SessionGuard)
export class StepUpController {
  constructor(
    private readonly totp: TotpService,
    private readonly db: DbService,
  ) {}

  @Get('totp/status')
  async status(@Req() req: EcrRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.totp.status(this.db.pool, req.ecr!.user.id);
  }

  /** Returns the secret once, for the QR code. Calling it again before confirming issues a new secret. */
  @Post('totp/enroll')
  @HttpCode(200)
  async enroll(@Req() req: EcrRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.totp.startEnrollment(req.ecr!.user.id, req.ecr!.user.email, ctxOf(req));
  }

  /** Confirms the first code; returns ten recovery codes that are shown only this once. */
  @Post('totp/confirm')
  @HttpCode(200)
  async confirm(@Req() req: EcrRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    const code = codeFrom(body, 'code');
    if (!code) throw new ApiError(400, 'INVALID_INPUT', 'Enter the 6-digit code from your authenticator app.');
    return this.totp.confirmEnrollment(req.ecr!.user.id, code, ctxOf(req));
  }

  @Post('step-up')
  @HttpCode(200)
  async stepUp(@Req() req: EcrRequest, @Body() body: unknown, @Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'no-store');
    return this.totp.stepUp(
      req.ecr!.user.id,
      { code: codeFrom(body, 'code'), recoveryCode: codeFrom(body, 'recoveryCode') },
      ctxOf(req),
    );
  }
}
