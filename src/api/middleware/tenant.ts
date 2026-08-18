import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { AuthContext, isSuperAdmin } from '../../domain/auth-context';
import { AuthenticatedRequest } from './auth';

export function getAuth(req: Request): AuthContext {
  const auth = (req as AuthenticatedRequest).auth;
  if (!auth) {
    throw new BusinessError('UNAUTHORIZED', 'Contexto de autenticación no disponible.');
  }
  return auth;
}

export function getEffectiveOrganizationId(req: Request): string | undefined {
  const auth = getAuth(req);
  if (isSuperAdmin(auth)) {
    const requested = (req.query.organizationId as string) || undefined;
    return requested;
  }
  return auth.organizationId ?? undefined;
}

export function requireOrganizationId(req: Request): string {
  const organizationId = getEffectiveOrganizationId(req);
  if (!organizationId) {
    throw new BusinessError(
      'TENANT_REQUIRED',
      'Se requiere un contexto de organización para esta operación.'
    );
  }
  return organizationId;
}

export function resolveCreateOrganizationId(req: Request): string {
  const auth = getAuth(req);
  if (isSuperAdmin(auth)) {
    const organizationId =
      (req.body?.organizationId as string) ||
      (req.query.organizationId as string) ||
      undefined;
    if (!organizationId) {
      throw new BusinessError(
        'TENANT_REQUIRED',
        'El super-admin debe indicar la organización destino (organizationId).'
      );
    }
    return organizationId;
  }
  return requireOrganizationId(req);
}

export function assertResourceInScope(
  resourceOrganizationId: string | undefined,
  auth: AuthContext,
  requestedOrganizationId?: string
): void {
  if (isSuperAdmin(auth) && !requestedOrganizationId) {
    return;
  }

  const scope = requestedOrganizationId ?? auth.organizationId;
  if (!scope || resourceOrganizationId !== scope) {
    throw new BusinessError(
      'FORBIDDEN_CROSS_TENANT',
      'No tienes acceso a este recurso. Pertenece a otra organización.'
    );
  }
}

export function requireTenantScope(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const auth = getAuth(req);
    if (isSuperAdmin(auth)) {
      next();
      return;
    }
    if (!auth.organizationId) {
      throw new BusinessError(
        'TENANT_REQUIRED',
        'El usuario no tiene una organización asignada.'
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}
