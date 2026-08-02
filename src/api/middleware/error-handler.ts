import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';

export function errorHandler(
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (err instanceof BusinessError) {
    res.status(400).json({
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
