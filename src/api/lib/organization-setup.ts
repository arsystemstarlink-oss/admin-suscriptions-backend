import { Organization } from '../../domain/entities';
import { BUSINESS_PLAN_TRIAL_DAYS } from '../../domain/business-plan';
import { organizationRepository } from '../../infrastructure/repositories';

/**
 * Plan inicial de una organización nueva: Básico en prueba con el tope y los
 * días de prueba del catálogo. Se comparte entre el alta del super-admin y el
 * alta autoservicio para que ambas creen exactamente el mismo estado.
 */
export function defaultOrganizationPlan(now = new Date()): Pick<
  Organization,
  'plan' | 'clientLimit' | 'planStatus' | 'billingDay' | 'trialEndsAt' | 'planExpiresAt' | 'clientCount'
> {
  const trialDays = BUSINESS_PLAN_TRIAL_DAYS.basico;
  return {
    plan: 'basico',
    clientLimit: 30,
    planStatus: 'prueba',
    billingDay: Math.min(Math.max(now.getUTCDate(), 1), 28),
    trialEndsAt: new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000),
    planExpiresAt: null,
    clientCount: 0,
  };
}

export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function resolveUniqueSlug(baseSlug: string, excludeId?: string): Promise<string> {
  let candidate = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await organizationRepository.findBySlug(candidate);
    if (!existing || existing.id === excludeId) {
      return candidate;
    }
    counter += 1;
    candidate = `${baseSlug}-${counter}`;
  }
}
