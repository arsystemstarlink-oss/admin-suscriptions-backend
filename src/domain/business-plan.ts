import {
  BusinessError,
  BusinessPlanKey,
  Organization,
  OrganizationPlanStatus,
} from './entities';

export const BUSINESS_PLAN_LIMITS: Record<BusinessPlanKey, number | null> = {
  basico: 30,
  pro: 150,
  negocio: 300,
  'a-medida': null,
};

export const BUSINESS_PLAN_ADMIN_LIMITS: Record<BusinessPlanKey, number> = {
  basico: 1,
  pro: 3,
  negocio: 5,
  'a-medida': 5,
};

export const CUSTOM_PLAN_MIN_CLIENTS = 301;

export function validateOrganizationAdminCount(plan: BusinessPlanKey, adminCount: number): void {
  const adminLimit = BUSINESS_PLAN_ADMIN_LIMITS[plan];
  if (adminCount >= adminLimit) {
    throw new BusinessError(
      'ADMIN_LIMIT_REACHED',
      `El plan ${plan} permite hasta ${adminLimit} administrador${adminLimit === 1 ? '' : 'es'}.`,
      { adminCount, adminLimit }
    );
  }
}

export function validateOrganizationAdminLimit(plan: BusinessPlanKey, adminCount: number): void {
  const adminLimit = BUSINESS_PLAN_ADMIN_LIMITS[plan];
  if (adminCount > adminLimit) {
    throw new BusinessError(
      'ADMIN_LIMIT_BELOW_USAGE',
      `No se puede asignar el plan ${plan}: la organización ya tiene ${adminCount} administradores y el límite es ${adminLimit}.`,
      { adminCount, adminLimit }
    );
  }
}

export function isPlanExpired(organization: Organization, now = new Date()): boolean {
  if (organization.planStatus === 'prueba') {
    return Boolean(organization.trialEndsAt && organization.trialEndsAt.getTime() <= now.getTime());
  }
  if (organization.planStatus === 'activo') {
    return Boolean(organization.planExpiresAt && organization.planExpiresAt.getTime() <= now.getTime());
  }
  return false;
}

export function validatePlanConfiguration(input: {
  plan: BusinessPlanKey;
  clientLimit: number;
  planStatus: OrganizationPlanStatus;
  trialEndsAt?: Date | null;
  planExpiresAt?: Date | null;
}): void {
  if (!Number.isInteger(input.clientLimit) || input.clientLimit <= 0) {
    throw new BusinessError('INVALID_CLIENT_LIMIT', 'El límite de clientes debe ser un entero positivo.');
  }

  const fixedLimit = BUSINESS_PLAN_LIMITS[input.plan];
  if (fixedLimit === null) {
    if (input.clientLimit < CUSTOM_PLAN_MIN_CLIENTS) {
      throw new BusinessError(
        'INVALID_CLIENT_LIMIT',
        `El plan A medida requiere un límite de al menos ${CUSTOM_PLAN_MIN_CLIENTS} clientes.`
      );
    }
  } else if (input.clientLimit !== fixedLimit) {
    throw new BusinessError(
      'INVALID_CLIENT_LIMIT',
      `El plan ${input.plan} tiene un límite fijo de ${fixedLimit} clientes.`
    );
  }

  if (input.planStatus === 'prueba') {
    if (input.plan !== 'basico') {
      throw new BusinessError('INVALID_PLAN_STATUS', 'La prueba solo está disponible para el plan Básico.');
    }
    if (!input.trialEndsAt || Number.isNaN(input.trialEndsAt.getTime())) {
      throw new BusinessError('INVALID_PLAN_DATE', 'La fecha de fin de prueba es obligatoria.');
    }
  }

  if (input.planStatus === 'activo' && (!input.planExpiresAt || Number.isNaN(input.planExpiresAt.getTime()))) {
    throw new BusinessError('INVALID_PLAN_DATE', 'La fecha de vencimiento del plan activo es obligatoria.');
  }
}

export function expiredPlanStatus(organization: Organization, now = new Date()): OrganizationPlanStatus | undefined {
  return isPlanExpired(organization, now) ? 'vencido' : undefined;
}
