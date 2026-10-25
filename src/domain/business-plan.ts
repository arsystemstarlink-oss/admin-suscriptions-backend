import {
  BusinessError,
  BusinessPlanKey,
  Organization,
  OrganizationPlanPaymentMethod,
  OrganizationPlanStatus,
} from './entities';

export const BUSINESS_PLAN_KEYS: BusinessPlanKey[] = ['basico', 'pro', 'negocio', 'a-medida'];

export const BUSINESS_PLAN_LABELS: Record<BusinessPlanKey, string> = {
  basico: 'Básico',
  pro: 'Pro',
  negocio: 'Negocio',
  'a-medida': 'A medida',
};

export const BUSINESS_PLAN_LIMITS: Record<BusinessPlanKey, number | null> = {
  basico: 30,
  pro: 75,
  negocio: 150,
  'a-medida': null,
};

export const BUSINESS_PLAN_ADMIN_LIMITS: Record<BusinessPlanKey, number> = {
  basico: 1,
  pro: 3,
  negocio: 5,
  'a-medida': 5,
};

export const BUSINESS_PLAN_PRICES: Record<BusinessPlanKey, number | null> = {
  basico: 15,
  pro: 25,
  negocio: 40,
  'a-medida': null,
};

export const MAX_PREPAID_MONTHS = 12;

export function isOrganizationPlanChange(input: {
  currentPlan?: BusinessPlanKey;
  targetPlan?: BusinessPlanKey;
  planStatus?: OrganizationPlanStatus;
}): boolean {
  return (
    input.planStatus === 'activo' &&
    Boolean(input.currentPlan && input.targetPlan && input.currentPlan !== input.targetPlan)
  );
}

export function resolveFixedPlanPaymentAmount(
  plan: BusinessPlanKey,
  months: number
): number | null {
  const monthlyPrice = BUSINESS_PLAN_PRICES[plan];
  return monthlyPrice === null ? null : monthlyPrice * months;
}

export const BUSINESS_PLAN_TRIAL_DAYS: Record<BusinessPlanKey, number> = {
  basico: 14,
  pro: 0,
  negocio: 0,
  'a-medida': 0,
};

export interface BusinessPlanCatalogItem {
  key: BusinessPlanKey;
  label: string;
  priceUsdMonthly: number | null;
  clientLimit: number | null;
  adminLimit: number;
  trialDays: number;
}

export function getBusinessPlanCatalog(): BusinessPlanCatalogItem[] {
  return BUSINESS_PLAN_KEYS.map((key) => ({
    key,
    label: BUSINESS_PLAN_LABELS[key],
    priceUsdMonthly: BUSINESS_PLAN_PRICES[key],
    clientLimit: BUSINESS_PLAN_LIMITS[key],
    adminLimit: BUSINESS_PLAN_ADMIN_LIMITS[key],
    trialDays: BUSINESS_PLAN_TRIAL_DAYS[key],
  }));
}

export function isBusinessPlanKey(value: unknown): value is BusinessPlanKey {
  return typeof value === 'string' && BUSINESS_PLAN_KEYS.includes(value as BusinessPlanKey);
}

export function isOrganizationPlanPaymentMethod(
  value: unknown
): value is OrganizationPlanPaymentMethod {
  return value === 'transferencia' || value === 'usdt' || value === 'efectivo';
}

export const CUSTOM_PLAN_MIN_CLIENTS = 151;

export function normalizeOrganizationBillingDay(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 1;
  return Math.min(Math.max(Math.trunc(numeric), 1), 28);
}

export function getOrganizationBillingDay(
  organization: Pick<
    Organization,
    'billingDay' | 'trialEndsAt' | 'planExpiresAt' | 'createdAt'
  >,
  fallback = new Date()
): number {
  const stored = organization.billingDay;
  if (typeof stored === 'number' && Number.isInteger(stored)) {
    return Math.min(Math.max(stored, 1), 28);
  }
  const anchor = organization.createdAt ?? organization.planExpiresAt ?? organization.trialEndsAt ?? fallback;
  return Math.min(Math.max(anchor.getUTCDate(), 1), 28);
}

export function addOrganizationBillingMonths(
  base: Date,
  months: number,
  billingDay: number
): Date {
  if (!Number.isInteger(months) || months < 1 || months > 12) {
    throw new BusinessError(
      'INVALID_PLAN_MONTHS',
      'Los meses a renovar deben ser un entero entre 1 y 12.'
    );
  }

  const day = normalizeOrganizationBillingDay(billingDay);
  const targetMonth = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + (base.getUTCDate() >= day ? 1 : 0), 1)
  );
  targetMonth.setUTCMonth(targetMonth.getUTCMonth() + (months - 1));
  const year = targetMonth.getUTCFullYear();
  const month = targetMonth.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay), 23, 59, 59, 999));
}

export function resolveOrganizationPlanExpiration(input: {
  paidAt: Date;
  months: number;
  billingDay: number;
  planStatus?: OrganizationPlanStatus;
  trialEndsAt?: Date | null;
  planExpiresAt?: Date | null;
  currentPlan?: BusinessPlanKey;
  targetPlan?: BusinessPlanKey;
  now?: Date;
}): Date {
  const now = input.now ?? new Date();
  const planChanged = isOrganizationPlanChange({
    currentPlan: input.currentPlan,
    targetPlan: input.targetPlan,
    planStatus: input.planStatus,
  });
  const paidActive =
    !planChanged &&
    input.planStatus === 'activo' &&
    Boolean(input.planExpiresAt && input.planExpiresAt.getTime() > now.getTime());
  const trialActive =
    input.planStatus === 'prueba' &&
    Boolean(input.trialEndsAt && input.trialEndsAt.getTime() > now.getTime());

  const base = paidActive
    ? input.planExpiresAt!
    : trialActive
      ? input.trialEndsAt!
      : new Date(Math.max(input.paidAt.getTime(), now.getTime()));

  return addOrganizationBillingMonths(base, input.months, input.billingDay);
}

export function assertPrepaidMonthsLimit(input: {
  newPlanExpiresAt: Date;
  billingDay: number;
  now?: Date;
}): void {
  const maxPlanExpiresAt = addOrganizationBillingMonths(
    input.now ?? new Date(),
    MAX_PREPAID_MONTHS,
    input.billingDay
  );

  if (input.newPlanExpiresAt.getTime() > maxPlanExpiresAt.getTime()) {
    throw new BusinessError(
      'PREPAID_LIMIT_REACHED',
      `No puedes prepagar más de ${MAX_PREPAID_MONTHS} meses. El vencimiento máximo permitido es ${maxPlanExpiresAt.toISOString().slice(0, 10)}.`
    );
  }
}

/**
 * Resuelve el límite de clientes que corresponde al plan.
 * Los planes fijos ignoran cualquier límite enviado por el cliente; A medida exige un límite explícito.
 */
export function resolveClientLimitForPlan(
  plan: BusinessPlanKey,
  requested?: unknown,
  existingLimit?: number
): number {
  const fixedLimit = BUSINESS_PLAN_LIMITS[plan];
  if (fixedLimit !== null) {
    return fixedLimit;
  }

  const candidate = requested === undefined || requested === null ? existingLimit : requested;
  if (
    typeof candidate !== 'number' ||
    !Number.isInteger(candidate) ||
    candidate < CUSTOM_PLAN_MIN_CLIENTS
  ) {
    throw new BusinessError(
      'INVALID_CLIENT_LIMIT',
      `El plan A medida requiere un límite de al menos ${CUSTOM_PLAN_MIN_CLIENTS} clientes.`
    );
  }

  return candidate;
}

export function assertPlanChangeAllowed(input: {
  currentPlanStatus?: OrganizationPlanStatus;
  currentTrialEndsAt?: Date | null;
  currentPlanExpiresAt?: Date | null;
  currentClientLimit?: number;
  targetClientLimit: number;
  now?: Date;
}): void {
  const now = input.now ?? new Date();
  const isPaidActive =
    input.currentPlanStatus === 'activo' &&
    (!input.currentPlanExpiresAt || input.currentPlanExpiresAt.getTime() > now.getTime());
  const isTrialActive =
    input.currentPlanStatus === 'prueba' &&
    Boolean(input.currentTrialEndsAt && input.currentTrialEndsAt.getTime() > now.getTime());

  if (!isPaidActive && !isTrialActive) {
    return;
  }

  if (input.targetClientLimit < (input.currentClientLimit ?? 0)) {
    throw new BusinessError(
      'PLAN_DOWNGRADE_NOT_ALLOWED',
      'No puedes bajar de plan mientras la suscripción esté vigente. Renueva el plan actual o espera a su vencimiento.'
    );
  }
}

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
