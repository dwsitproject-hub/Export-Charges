import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Error with a stable code the web app maps to a message (Technical Design §5.2). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

const HTTP_CODES: Record<number, string> = {
  400: 'INVALID_INPUT',
  401: 'NOT_SIGNED_IN',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  413: 'FILE_TOO_LARGE',
  429: 'RATE_LIMITED',
};

@Catch()
export class ApiErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('ApiError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = res.locals.traceId as string | undefined;

    if (exception instanceof ApiError) {
      res.status(exception.status).json({
        error: { code: exception.code, message: exception.message, details: exception.details, traceId },
      });
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      res.status(status).json({
        error: { code: HTTP_CODES[status] ?? 'ERROR', message: exception.message, traceId },
      });
      return;
    }
    this.logger.error(`[${traceId}] ${(exception as Error)?.stack ?? exception}`);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.', traceId } });
  }
}
