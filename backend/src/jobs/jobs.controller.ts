import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { actorOf } from '../auth/actor';
import { Authorize, AuthorizedRequest } from '../auth/authorize';
import { JobsService } from './jobs.service';

/** Technical Design §4.2.7 and §5.1 "Operations": scheduled jobs and the nightly data-quality dashboard. */
@Controller()
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  /** Each job with its schedule and last run (Auditors and Super Admins). */
  @Get('jobs')
  @Authorize({ permissions: ['page.jobs'] })
  list() {
    return this.jobs.list();
  }

  @Get('jobs/:name/runs')
  @Authorize({ permissions: ['page.jobs'] })
  history(@Param('name') name: string) {
    return this.jobs.history(name);
  }

  /** Runs a job now (Super Admin, fresh authenticator code); 409 JOB_RUNNING if it is running elsewhere. */
  @Post('jobs/:name/run')
  @HttpCode(200)
  @Authorize({ permissions: ['config.manage'], stepUp: true })
  runNow(@Param('name') name: string, @Req() req: AuthorizedRequest) {
    return this.jobs.runNow(actorOf(req), name);
  }

  /** US-51-P1: findings of the latest nightly data-quality run. */
  @Get('dq/findings')
  @Authorize({ permissions: ['dq.read'] })
  dqFindings() {
    return this.jobs.dqFindings();
  }
}
