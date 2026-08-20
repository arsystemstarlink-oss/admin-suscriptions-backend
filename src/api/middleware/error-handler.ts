import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { extractTwilioError } from '../../infrastructure/whatsapp-service';

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
  CANNOT_DELETE_SELF: 403,
  LAST_ADMIN: 409,
  VAPID_NOT_CONFIGURED: 503,
  WHATSAPP_NOT_CONFIGURED: 503,
  JOB_ALREADY_RUNNING: 409,
  PUSH_SUBSCRIPTION_NOT_FOUND: 404,
  INVALID_PAYLOAD: 400,
  CROSS_TENANT_REFERENCE: 403,
  FORBIDDEN_CROSS_TENANT: 403,
  TENANT_REQUIRED: 403,
  ORGANIZATION_NOT_FOUND: 404,
  ORGANIZATION_INACTIVE: 403,
  TWILIO_ERROR: 502,
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

  const twilioError = extractTwilioError(err);
  if (twilioError) {
    console.error('Twilio error:', twilioError);
    res.status(STATUS_BY_CODE.TWILIO_ERROR).json({
      error: {
        code: 'TWILIO_ERROR',
        message: twilioError.message,
        twilioCode: twilioError.code,
        moreInfo: twilioError.moreInfo,
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
