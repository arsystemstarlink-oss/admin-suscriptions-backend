import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { authService, TokenPayload } from '../../domain/auth-service';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
}

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

      if (payload.role !== 'admin') {
        throw new BusinessError('FORBIDDEN', 'Se requieren permisos de administrador.');
      }

      (req as AuthenticatedRequest).user = payload;
      next();
    } catch (error) {
      if (error instanceof BusinessError) {
        throw error;
      }
      throw new BusinessError('UNAUTHORIZED', 'Token inválido o expirado.');
    }
  } catch (err) {
    next(err);
  }
}
