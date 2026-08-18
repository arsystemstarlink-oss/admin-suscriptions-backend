import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { AuthContext } from '../../domain/auth-context';
import { authService, TokenPayload, toAuthContext } from '../../domain/auth-service';
import { userRepository } from '../../infrastructure/repositories';

export interface AuthenticatedRequest extends Request {
  user?: TokenPayload;
  auth?: AuthContext;
}

export const ADMIN_ROLES = ['admin', 'super-admin'];

export function authenticateAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  (async () => {
    const authHeader = req.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new BusinessError('UNAUTHORIZED', 'Acceso no autorizado. Se requiere token JWT.');
    }

    const token = authHeader.substring(7);

    let payload: TokenPayload;
    try {
      payload = authService.verifyAccessToken(token);
    } catch {
      throw new BusinessError('UNAUTHORIZED', 'Token inválido o expirado.');
    }

    if (!ADMIN_ROLES.includes(payload.role)) {
      throw new BusinessError('FORBIDDEN', 'Se requieren permisos de administrador.');
    }

    const user = await userRepository.getById(payload.userId);
    if (!user) {
      throw new BusinessError('UNAUTHORIZED', 'Usuario no encontrado.');
    }

    if (user.role !== payload.role) {
      throw new BusinessError('FORBIDDEN', 'El rol del usuario ha cambiado. Inicia sesión nuevamente.');
    }

    if (user.role === 'admin' && !user.organizationId) {
      throw new BusinessError('FORBIDDEN', 'El usuario no tiene una organización asignada.');
    }

    const auth = toAuthContext({
      ...payload,
      role: user.role,
      organizationId: user.organizationId ?? null,
    });

    (req as AuthenticatedRequest).user = payload;
    (req as AuthenticatedRequest).auth = auth;
    next();
  })().catch(next);
}

export function requireSuperAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth || auth.role !== 'super-admin') {
    next(new BusinessError('FORBIDDEN', 'Solo el super-admin puede realizar esta operación.'));
    return;
  }
  next();
}
