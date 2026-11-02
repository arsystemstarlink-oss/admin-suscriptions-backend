import { Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import {
  canOrganizationWrite,
  resolveEffectiveClientLimit,
  validatePlanConfiguration,
} from '../../domain/business-plan';
import { organizationRepository } from '../../infrastructure/repositories';
import { getAuth, requireOrganizationId } from './tenant';
import { isSuperAdmin } from '../../domain/auth-context';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function requireWritablePlan(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    if (!WRITE_METHODS.has(req.method.toUpperCase()) || isSuperAdmin(getAuth(req))) {
      next();
      return;
    }

    const organizationId = requireOrganizationId(req);
    const organization = await organizationRepository.getById(organizationId);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }
    const current = await organizationRepository.refreshExpiredStatus(organization);

    // Los planes fijos mandan sobre el límite almacenado. Así una organización con
    // datos heredados (p.ej. plan Pro con clientLimit de Básico) sigue pudiendo
    // escribir; el tope real se deriva del catálogo vigente.
    const clientLimit = resolveEffectiveClientLimit(current.plan, current.clientLimit);
    if (
      !current.plan ||
      !current.planStatus ||
      clientLimit === null ||
      !Number.isInteger(clientLimit) ||
      clientLimit <= 0 ||
      !Number.isInteger(current.clientCount) ||
      current.clientCount! < 0
    ) {
      throw new BusinessError(
        'PLAN_NOT_CONFIGURED',
        'El plan de la organización aún no está configurado. Contacta al super-admin.'
      );
    }
    validatePlanConfiguration({
      plan: current.plan,
      clientLimit,
      planStatus: current.planStatus,
      trialEndsAt: current.trialEndsAt,
      planExpiresAt: current.planExpiresAt,
    });
    if (!canOrganizationWrite(current)) {
      throw new BusinessError(
        'PLAN_READ_ONLY',
        'El plan venció o está suspendido. La organización está en modo de solo lectura.'
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}
