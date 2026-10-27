import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { extractTwilioError } from '../../infrastructure/whatsapp-service';
import { isFirestoreQuotaError, isFirestoreIndexError, getFirestoreIndexLink } from '../../infrastructure/firestore-error';
import { BUSINESS_ERROR_HTTP_STATUS } from '../../domain/error-codes';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof BusinessError) {
    const status = BUSINESS_ERROR_HTTP_STATUS[err.code] ?? 400;
    res.status(status).json({
      error: {
        code: err.code,
        message: err.message,
        ...err.details,
      },
    });
    return;
  }

  const twilioError = extractTwilioError(err);
  if (twilioError) {
    console.error('Twilio error:', twilioError);
    res.status(BUSINESS_ERROR_HTTP_STATUS.TWILIO_ERROR).json({
      error: {
        code: 'TWILIO_ERROR',
        message: twilioError.message,
        twilioCode: twilioError.code,
        moreInfo: twilioError.moreInfo,
      },
    });
    return;
  }

  if (isFirestoreQuotaError(err)) {
    console.error('Firestore quota exceeded:', err);
    res.status(503).json({
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'La base de datos alcanzó su límite diario de uso. Intenta más tarde.',
      },
    });
    return;
  }

  if (isFirestoreIndexError(err)) {
    console.error('Firestore index missing:', err);
    res.status(503).json({
      error: {
        code: 'DATABASE_INDEX_BUILDING',
        message: 'La base de datos está creando un índice necesario. Reintenta en unos minutos o habilítalo con el enlace de Firebase.',
        moreInfo: getFirestoreIndexLink(err),
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
