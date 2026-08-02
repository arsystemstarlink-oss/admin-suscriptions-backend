import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { authService } from '../../domain/auth-service';

export function authenticateAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new BusinessError('UNAUTHORIZED', 'Acceso no autorizado. Se requiere token JWT.');
    }

    const token = authHeader.substring(7);

    try {
      const payload = authService.verifyAccessToken(token);
      (req as any).user = payload;
      next();
    } catch (error) {
      throw new BusinessError('UNAUTHORIZED', 'Token inválido o expirado.');
    }
  } catch (err) {
    next(err);
  }
}
