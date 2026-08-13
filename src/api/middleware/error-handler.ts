import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';

const STATUS_BY_CODE: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  INVALID_CREDENTIALS: 401,
  INVALID_WEBHOOK: 403,
  REFRESH_TOKEN_REVOKED: 401,
  NOT_FOUND: 404,
  USER_NOT_FOUND: 404,
  EMAIL_TAKEN: 409,
  SETUP_DISABLED: 403,
  INVALID_SETUP_KEY: 403,
  RATE_LIMITED: 429,
};

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof BusinessError) {
    const status = STATUS_BY_CODE[err.code] ?? 400;
    res.status(status).json({
      error: {
        code: err.code,
        message: err.message,
      },
    });
    return;
  }

  console.error('Unexpected error:', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Error interno del servidor.',
    },
  });
}
