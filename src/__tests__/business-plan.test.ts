import {
  BUSINESS_PLAN_ADMIN_LIMITS,
  addOrganizationBillingMonths,
  assertPlanChangeAllowed,
  assertPrepaidMonthsLimit,
  getBusinessPlanCatalog,
  getOrganizationBillingDay,
  isOrganizationPlanLocked,
  isPlanExpired,
  resolveClientLimitForPlan,
  resolveFixedPlanPaymentAmount,
  resolveOrganizationPlanExpiration,
  validateOrganizationAdminCount,
  validateOrganizationAdminLimit,
  validatePlanConfiguration,
  assertFuturePlanDates,
} from '../domain/business-plan';
import { Organization } from '../domain/entities';

const now = new Date('2026-10-22T12:00:00.000Z');

function organization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org_1',
    name: 'Organización',
    active: true,
    plan: 'basico',
    clientLimit: 30,
    planStatus: 'activo',
    planExpiresAt: new Date('2026-10-23T00:00:00.000Z'),
    trialEndsAt: null,
    clientCount: 0,
    createdAt: now,
    ...overrides,
  };
}

describe('business plan rules', () => {
  it.each([
    ['basico', 1],
    ['pro', 3],
    ['negocio', 5],
    ['a-medida', 5],
  ] as const)('sets the administrator limit for %s', (plan, adminLimit) => {
    expect(BUSINESS_PLAN_ADMIN_LIMITS[plan]).toBe(adminLimit);
    expect(() => validateOrganizationAdminCount(plan, adminLimit - 1)).not.toThrow();
    expect(() => validateOrganizationAdminCount(plan, adminLimit)).toThrow('permite hasta');
  });

  it('prevents changing to a plan below the current administrator count', () => {
    expect(() => validateOrganizationAdminLimit('basico', 1)).not.toThrow();
    expect(() => validateOrganizationAdminLimit('basico', 2)).toThrow('ya tiene 2 administradores');
  });

  it.each([
    ['basico', 30],
    ['pro', 75],
    ['negocio', 150],
  ] as const)('accepts the fixed limit for %s', (plan, clientLimit) => {
    expect(() =>
      validatePlanConfiguration({
        plan,
        clientLimit,
        planStatus: 'activo',
        planExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
      })
    ).not.toThrow();
  });

  it('requires custom plans to exceed 150 clients', () => {
    expect(() =>
      validatePlanConfiguration({
        plan: 'a-medida',
        clientLimit: 150,
        planStatus: 'activo',
        planExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
      })
    ).toThrow('al menos 151');
  });

  it.each([
    ['basico', 30],
    ['pro', 75],
    ['negocio', 150],
  ] as const)('derives the fixed client limit for %s', (plan, clientLimit) => {
    expect(resolveClientLimitForPlan(plan, 999, 10)).toBe(clientLimit);
    expect(resolveClientLimitForPlan(plan, undefined, 10)).toBe(clientLimit);
  });

  it('requires an explicit limit for a custom plan', () => {
    expect(resolveClientLimitForPlan('a-medida', 500, 30)).toBe(500);
    expect(resolveClientLimitForPlan('a-medida', undefined, 400)).toBe(400);
    expect(() => resolveClientLimitForPlan('a-medida', undefined, 30)).toThrow('al menos 151');
    expect(() => resolveClientLimitForPlan('a-medida', 150, 30)).toThrow('al menos 151');
  });

  it('blocks downgrades while the paid plan is active', () => {
    const active = {
      currentPlanStatus: 'activo' as const,
      currentPlanExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
      currentClientLimit: 150,
      now,
    };
    expect(() =>
      assertPlanChangeAllowed({ ...active, targetClientLimit: 30 })
    ).toThrow('No puedes bajar de plan');
    expect(() =>
      assertPlanChangeAllowed({ ...active, targetClientLimit: 150 })
    ).not.toThrow();
    expect(() =>
      assertPlanChangeAllowed({ ...active, targetClientLimit: 300 })
    ).not.toThrow();
  });

  it('allows downgrades after expiry or while suspended', () => {
    expect(() =>
      assertPlanChangeAllowed({
        currentPlanStatus: 'activo',
        currentPlanExpiresAt: new Date('2026-10-22T11:59:59.999Z'),
        currentClientLimit: 150,
        targetClientLimit: 30,
        now,
      })
    ).not.toThrow();
    expect(() =>
      assertPlanChangeAllowed({
        currentPlanStatus: 'suspendido',
        currentClientLimit: 150,
        targetClientLimit: 30,
        now,
      })
    ).not.toThrow();
  });

  it('blocks lowering a custom limit while the plan is active', () => {
    expect(() =>
      assertPlanChangeAllowed({
        currentPlanStatus: 'activo',
        currentPlanExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
        currentClientLimit: 500,
        targetClientLimit: 400,
        now,
      })
    ).toThrow('No puedes bajar de plan');
  });

  it('only permits a dated trial on the Basic plan', () => {
    expect(() =>
      validatePlanConfiguration({
        plan: 'pro',
        clientLimit: 75,
        planStatus: 'prueba',
        trialEndsAt: new Date('2026-11-01T00:00:00.000Z'),
      })
    ).toThrow('solo está disponible');
    expect(() =>
      validatePlanConfiguration({
        plan: 'basico',
        clientLimit: 30,
        planStatus: 'prueba',
      })
    ).toThrow('fin de prueba es obligatoria');
  });

  it('requires an expiration date for active plans', () => {
    expect(() =>
      validatePlanConfiguration({
        plan: 'basico',
        clientLimit: 30,
        planStatus: 'activo',
      })
    ).toThrow('vencimiento del plan activo es obligatoria');
  });

  it('rejects past dates on write validation and accepts them on read-path validation', () => {
    expect(() =>
      assertFuturePlanDates({
        planStatus: 'activo',
        planExpiresAt: new Date('2026-10-01T00:00:00.000Z'),
        now,
      })
    ).toThrow('debe ser futura');

    expect(() =>
      assertFuturePlanDates({
        planStatus: 'prueba',
        trialEndsAt: new Date('2026-10-01T00:00:00.000Z'),
        now,
      })
    ).toThrow('debe ser futura');

    expect(() =>
      validatePlanConfiguration({
        plan: 'basico',
        clientLimit: 30,
        planStatus: 'activo',
        planExpiresAt: new Date('2026-10-01T00:00:00.000Z'),
      })
    ).not.toThrow();
  });


  it('evaluates trial and paid expiration using UTC instants', () => {
    expect(
      isPlanExpired(
        organization({
          planStatus: 'prueba',
          trialEndsAt: new Date('2026-10-22T11:59:59.999Z'),
          planExpiresAt: null,
        }),
        now
      )
    ).toBe(true);
    expect(isPlanExpired(organization(), now)).toBe(false);
    expect(
      isPlanExpired(
        organization({ planStatus: 'suspendido', planExpiresAt: new Date('2026-10-01T00:00:00Z') }),
        now
      )
    ).toBe(false);
  });

  it('locks changes only while the paid or trial plan is still valid', () => {
    expect(isOrganizationPlanLocked(organization(), now)).toBe(true);
    expect(
      isOrganizationPlanLocked(
        organization({ planExpiresAt: new Date('2026-10-22T11:59:59.999Z') }),
        now
      )
    ).toBe(false);
    expect(
      isOrganizationPlanLocked(
        organization({
          planStatus: 'prueba',
          trialEndsAt: new Date('2026-10-23T12:00:00.000Z'),
          planExpiresAt: null,
        }),
        now
      )
    ).toBe(true);
    expect(
      isOrganizationPlanLocked(
        organization({
          planStatus: 'prueba',
          trialEndsAt: new Date('2026-10-22T11:59:59.999Z'),
          planExpiresAt: null,
        }),
        now
      )
    ).toBe(false);
    expect(
      isOrganizationPlanLocked(
        organization({ planStatus: 'suspendido', planExpiresAt: null }),
        now
      )
    ).toBe(false);
    expect(
      isOrganizationPlanLocked(organization({ planExpiresAt: null }), now)
    ).toBe(true);
  });

  it('derives the billing day from the registration date when it is not stored', () => {
    expect(
      getOrganizationBillingDay(
        organization({
          billingDay: undefined,
          createdAt: new Date('2026-11-07T12:00:00.000Z'),
        })
      )
    ).toBe(7);
    expect(
      getOrganizationBillingDay(
        organization({ billingDay: 31, planExpiresAt: new Date('2026-11-07T00:00:00.000Z') })
      )
    ).toBe(28);
  });

  it('anchors monthly expirations to the next billing day', () => {
    expect(
      addOrganizationBillingMonths(new Date('2026-11-07T12:00:00.000Z'), 1, 24).toISOString()
    ).toBe('2026-11-24T23:59:59.999Z');
    expect(
      addOrganizationBillingMonths(new Date('2026-11-30T12:00:00.000Z'), 1, 24).toISOString()
    ).toBe('2026-12-24T23:59:59.999Z');
    expect(
      addOrganizationBillingMonths(new Date('2026-01-31T12:00:00.000Z'), 1, 31).toISOString()
    ).toBe('2026-02-28T23:59:59.999Z');
    expect(() => addOrganizationBillingMonths(new Date(), 0, 7)).toThrow('entre 1 y 12');
  });

  it('exposes the fixed monthly prices from the backend catalog', () => {
    const catalog = getBusinessPlanCatalog();
    expect(catalog.map((plan) => [plan.key, plan.priceUsdMonthly])).toEqual([
      ['basico', 15],
      ['pro', 25],
      ['negocio', 40],
      ['a-medida', null],
    ]);
  });

  it('calculates the fixed plan payment total by renewal months', () => {
    expect(resolveFixedPlanPaymentAmount('basico', 1)).toBe(15);
    expect(resolveFixedPlanPaymentAmount('basico', 3)).toBe(45);
    expect(resolveFixedPlanPaymentAmount('pro', 6)).toBe(150);
    expect(resolveFixedPlanPaymentAmount('negocio', 12)).toBe(480);
    expect(resolveFixedPlanPaymentAmount('a-medida', 3)).toBeNull();
  });

  it('starts the paid cycle after an active trial and stacks active renewals', () => {
    expect(
      resolveOrganizationPlanExpiration({
        paidAt: new Date('2026-10-22T12:00:00.000Z'),
        months: 1,
        billingDay: 24,
        planStatus: 'prueba',
        trialEndsAt: new Date('2026-11-07T12:00:00.000Z'),
        planExpiresAt: null,
        now,
      }).toISOString()
    ).toBe('2026-11-24T23:59:59.999Z');

    expect(
      resolveOrganizationPlanExpiration({
        paidAt: new Date('2026-10-22T12:00:00.000Z'),
        months: 1,
        billingDay: 7,
        planStatus: 'activo',
        trialEndsAt: null,
        planExpiresAt: new Date('2026-11-07T23:59:59.999Z'),
        now,
      }).toISOString()
    ).toBe('2026-12-07T23:59:59.999Z');
  });

  it('resets the term when the active plan changes instead of summing both plans', () => {
    const base = {
      paidAt: new Date('2026-10-25T12:00:00.000Z'),
      months: 12,
      billingDay: 20,
      planStatus: 'activo' as const,
      trialEndsAt: null,
      planExpiresAt: new Date('2026-11-20T23:59:59.999Z'),
      now: new Date('2026-10-25T12:00:00.000Z'),
    };

    expect(
      resolveOrganizationPlanExpiration({
        ...base,
        currentPlan: 'basico',
        targetPlan: 'pro',
      }).toISOString()
    ).toBe('2027-10-20T23:59:59.999Z');

    expect(
      resolveOrganizationPlanExpiration({
        ...base,
        currentPlan: 'pro',
        targetPlan: 'pro',
      }).toISOString()
    ).toBe('2027-11-20T23:59:59.999Z');
  });

  it('rejects expirations beyond the 12-month prepaid cap', () => {
    expect(() =>
      assertPrepaidMonthsLimit({
        newPlanExpiresAt: new Date('2027-10-20T23:59:59.999Z'),
        billingDay: 20,
        now: new Date('2026-10-25T12:00:00.000Z'),
      })
    ).not.toThrow();

    expect(() =>
      assertPrepaidMonthsLimit({
        newPlanExpiresAt: new Date('2027-10-21T00:00:00.000Z'),
        billingDay: 20,
        now: new Date('2026-10-25T12:00:00.000Z'),
      })
    ).toThrow('No puedes prepagar más de 12 meses.');
  });
});
