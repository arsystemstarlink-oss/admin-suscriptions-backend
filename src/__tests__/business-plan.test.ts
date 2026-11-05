import {
  BUSINESS_PLAN_ADMIN_LIMITS,
  MAX_PREPAID_MONTHS,
  PREPAID_MONTH_OPTIONS,
  addOrganizationBillingMonths,
  assertPlanChangeAllowed,
  assertPrepaidMonthsLimit,
  canOrganizationWrite,
  getBusinessPlanCatalog,
  getOrganizationBillingDay,
  isOrganizationPlanLocked,
  isPlanExpired,
  resolveClientLimitForPlan,
  resolveEffectiveClientLimit,
  resolveFixedPlanPaymentAmount,
  resolveOrganizationPlanExpiration,
  resolveOrganizationPlanPaymentAmount,
  resolvePlanChangeDifference,
  resolvePlanPaymentBillingDay,
  resolvePrepaidLimitStart,
  resolveOrganizationAccessStatus,
  resolveOrganizationPlanMonths,
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

  describe('plan change within the paid term', () => {
    const paidAt = new Date('2026-10-25T12:00:00.000Z');
    const changeNow = new Date('2026-10-25T12:00:00.000Z');
    const expiry = new Date('2027-09-20T23:59:59.999Z');
    const proActive = {
      plan: 'pro' as const,
      planStatus: 'activo' as const,
      planExpiresAt: expiry,
    };
    const expirationBase = {
      paidAt,
      billingDay: 20,
      planStatus: 'activo' as const,
      trialEndsAt: null,
      planExpiresAt: expiry,
      currentPlan: 'pro' as const,
      targetPlan: 'negocio' as const,
      now: changeNow,
    };

    it('keeps the current expiry when only the difference is paid', () => {
      expect(resolveOrganizationPlanExpiration({ ...expirationBase, months: 0 })).toEqual(expiry);
    });

    it('adds the extra months on top of the current expiry', () => {
      expect(
        resolveOrganizationPlanExpiration({ ...expirationBase, months: 1 }).toISOString()
      ).toBe('2027-10-20T23:59:59.999Z');
    });

    it('charges the price difference for the 330 remaining days', () => {
      expect(
        resolvePlanChangeDifference({
          targetPlan: 'negocio',
          paidAt,
          organization: proActive,
          now: changeNow,
        })
      ).toBe(162.74);
    });

    it('adds the months at the new price to the difference', () => {
      expect(
        resolveOrganizationPlanPaymentAmount({
          plan: 'negocio',
          months: 0,
          paidAt,
          organization: proActive,
          now: changeNow,
        })
      ).toBe(162.74);
      expect(
        resolveOrganizationPlanPaymentAmount({
          plan: 'negocio',
          months: 1,
          paidAt,
          organization: proActive,
          now: changeNow,
        })
      ).toBe(202.74);
    });

    it('charges no difference on a renewal, after expiry or during a trial', () => {
      const difference = (organization: Parameters<typeof resolvePlanChangeDifference>[0]['organization']) =>
        resolvePlanChangeDifference({ targetPlan: 'negocio', paidAt, organization, now: changeNow });

      expect(difference({ ...proActive, plan: 'negocio' })).toBe(0);
      expect(difference({ ...proActive, planExpiresAt: new Date('2026-10-01T23:59:59.999Z') })).toBe(0);
      expect(difference({ plan: 'basico', planStatus: 'prueba', planExpiresAt: null })).toBe(0);
    });

    it('leaves the amount of a custom plan to the agreed price', () => {
      expect(
        resolvePlanChangeDifference({
          targetPlan: 'a-medida',
          paidAt,
          organization: proActive,
          now: changeNow,
        })
      ).toBe(0);
      expect(
        resolveOrganizationPlanPaymentAmount({
          plan: 'a-medida',
          months: 0,
          paidAt,
          organization: proActive,
          now: changeNow,
        })
      ).toBeNull();
    });

    it('accepts zero months only for a plan change within the term', () => {
      expect(resolveOrganizationPlanMonths(0, { allowDifferenceOnly: true })).toBe(0);
      expect(() => resolveOrganizationPlanMonths(0)).toThrow('entre 1 y 12');
      expect(() =>
        resolveOrganizationPlanExpiration({ ...expirationBase, months: 0, targetPlan: 'pro' })
      ).toThrow('cambio de plan con tiempo vigente');
      expect(() =>
        resolveOrganizationPlanExpiration({
          ...expirationBase,
          months: 0,
          planExpiresAt: new Date('2026-10-01T23:59:59.999Z'),
        })
      ).toThrow('cambio de plan con tiempo vigente');
    });
  });

  it('stacks months on the current expiry when the active plan stays the same', () => {
    expect(
      resolveOrganizationPlanExpiration({
        paidAt: new Date('2026-10-25T12:00:00.000Z'),
        months: 12,
        billingDay: 20,
        planStatus: 'activo',
        trialEndsAt: null,
        planExpiresAt: new Date('2026-11-20T23:59:59.999Z'),
        currentPlan: 'pro',
        targetPlan: 'pro',
        now: new Date('2026-10-25T12:00:00.000Z'),
      }).toISOString()
    ).toBe('2027-11-20T23:59:59.999Z');
  });

  describe('payment during an active trial', () => {
    // Alta el 24 de octubre: la prueba de 14 días termina el 7 de noviembre.
    const now = new Date('2026-10-25T12:00:00.000Z');
    const trial = {
      billingDay: 24,
      planStatus: 'prueba' as const,
      trialEndsAt: new Date('2026-11-07T12:00:00.000Z'),
      planExpiresAt: null,
      createdAt: new Date('2026-10-24T12:00:00.000Z'),
    };

    const pay = (months: number, signupPayment?: boolean) => {
      const billingDay = resolvePlanPaymentBillingDay({
        paidAt: now,
        organization: trial,
        signupPayment,
        now,
      });
      return {
        billingDay,
        expiry: resolveOrganizationPlanExpiration({
          ...trial,
          paidAt: now,
          months,
          billingDay,
          now,
        }),
      };
    };

    it('gives a full month after the trial and moves the billing day to its end', () => {
      const { billingDay, expiry } = pay(1);

      expect(billingDay).toBe(7);
      expect(expiry.toISOString()).toBe('2026-12-07T23:59:59.999Z');
    });

    it('keeps the signup billing day for a payment made when signing up', () => {
      const { billingDay, expiry } = pay(1, true);

      expect(billingDay).toBe(24);
      expect(expiry.toISOString()).toBe('2026-11-24T23:59:59.999Z');
    });

    it('allows prepaying twelve full months counted from the end of the trial', () => {
      const { billingDay, expiry } = pay(12);

      expect(expiry.toISOString()).toBe('2027-11-07T23:59:59.999Z');
      expect(() =>
        assertPrepaidMonthsLimit({
          newPlanExpiresAt: expiry,
          billingDay,
          now: resolvePrepaidLimitStart({ organization: trial, now }),
        })
      ).not.toThrow();
    });

    it('measures the prepaid limit from today once the trial is over or was paid at signup', () => {
      expect(resolvePrepaidLimitStart({ organization: trial, signupPayment: true, now })).toBe(now);
      expect(
        resolvePrepaidLimitStart({
          organization: { ...trial, trialEndsAt: new Date('2026-10-01T12:00:00.000Z') },
          now,
        })
      ).toBe(now);
    });
  });

  describe('payment after the plan lapsed', () => {
    const lapsed = {
      billingDay: 20,
      planStatus: 'vencido' as const,
      trialEndsAt: null,
      planExpiresAt: new Date('2026-09-20T23:59:59.999Z'),
      createdAt: new Date('2026-01-20T00:00:00.000Z'),
    };

    const pay = (date: string, months = 1) => {
      const at = new Date(`${date}T12:00:00.000Z`);
      const billingDay = resolvePlanPaymentBillingDay({ paidAt: at, organization: lapsed, now: at });
      return {
        at,
        billingDay,
        expiry: resolveOrganizationPlanExpiration({
          ...lapsed,
          paidAt: at,
          months,
          billingDay,
          now: at,
        }),
      };
    };

    it.each(['2026-10-05', '2026-10-19', '2026-10-20', '2026-10-21'])(
      'covers a full month when paying on %s',
      (date) => {
        const { at, expiry } = pay(date);
        const days = (expiry.getTime() - at.getTime()) / (24 * 60 * 60 * 1000);

        expect(days).toBeGreaterThanOrEqual(30);
        expect(days).toBeLessThanOrEqual(32);
      }
    );

    it('moves the billing day to the payment day', () => {
      const { billingDay, expiry } = pay('2026-10-19');

      expect(billingDay).toBe(19);
      expect(expiry.toISOString()).toBe('2026-11-19T23:59:59.999Z');
    });

    it('caps the new billing day at 28 for payments at the end of the month', () => {
      const { billingDay, expiry } = pay('2027-01-31');

      expect(billingDay).toBe(28);
      expect(expiry.toISOString()).toBe('2027-02-28T23:59:59.999Z');
    });

    it('keeps a twelve-month payment inside the prepaid cap', () => {
      const { at, billingDay, expiry } = pay('2026-10-19', 12);

      expect(expiry.toISOString()).toBe('2027-10-19T23:59:59.999Z');
      expect(() =>
        assertPrepaidMonthsLimit({ newPlanExpiresAt: expiry, billingDay, now: at })
      ).not.toThrow();
    });

    it('keeps the billing day while a paid term is active', () => {
      const now = new Date('2026-10-19T12:00:00.000Z');

      expect(
        resolvePlanPaymentBillingDay({
          paidAt: now,
          now,
          organization: {
            ...lapsed,
            planStatus: 'activo',
            planExpiresAt: new Date('2026-11-20T23:59:59.999Z'),
          },
        })
      ).toBe(20);
    });

    it('restarts the cycle when the status still says active but the term ended', () => {
      const now = new Date('2026-10-19T12:00:00.000Z');

      expect(
        resolvePlanPaymentBillingDay({
          paidAt: now,
          now,
          organization: { ...lapsed, planStatus: 'activo' },
        })
      ).toBe(19);
    });
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

  it('defaults missing months to one month and rejects out-of-range values', () => {
    expect(resolveOrganizationPlanMonths(undefined)).toBe(1);
    expect(resolveOrganizationPlanMonths(null)).toBe(1);
    expect(resolveOrganizationPlanMonths('3')).toBe(3);
    expect(resolveOrganizationPlanMonths(12)).toBe(12);
    expect(() => resolveOrganizationPlanMonths(0)).toThrow('entre 1 y 12');
    expect(() => resolveOrganizationPlanMonths(13)).toThrow('entre 1 y 12');
    expect(() => resolveOrganizationPlanMonths(1.5)).toThrow('entre 1 y 12');
    expect(() => resolveOrganizationPlanMonths('abc')).toThrow('entre 1 y 12');
  });

  it('keeps the offered prepaid month options inside the prepaid cap', () => {
    PREPAID_MONTH_OPTIONS.forEach((months) => {
      expect(months).toBeGreaterThanOrEqual(1);
      expect(months).toBeLessThanOrEqual(MAX_PREPAID_MONTHS);
    });
    expect(PREPAID_MONTH_OPTIONS).toEqual([1, 3, 6, 12]);
  });

  it('derives the effective client limit from the fixed plan even when stored data is stale', () => {
    expect(resolveEffectiveClientLimit('basico', 500)).toBe(30);
    expect(resolveEffectiveClientLimit('pro', 20)).toBe(75);
    expect(resolveEffectiveClientLimit('negocio', undefined)).toBe(150);
    expect(resolveEffectiveClientLimit('a-medida', 400)).toBe(400);
    expect(resolveEffectiveClientLimit('a-medida', undefined)).toBeNull();
    expect(resolveEffectiveClientLimit(undefined, 30)).toBeNull();
  });

  it('reports an expired access status for a stale active or trial plan', () => {
    expect(
      resolveOrganizationAccessStatus(
        organization({ planExpiresAt: new Date('2026-10-22T11:59:59.999Z') }),
        now
      )
    ).toBe('vencido');
    expect(
      resolveOrganizationAccessStatus(
        organization({ planStatus: 'prueba', trialEndsAt: new Date('2026-10-22T11:59:59.999Z') }),
        now
      )
    ).toBe('vencido');
    expect(resolveOrganizationAccessStatus(organization(), now)).toBe('activo');
    expect(
      resolveOrganizationAccessStatus(organization({ planStatus: 'suspendido' }), now)
    ).toBe('suspendido');
    expect(resolveOrganizationAccessStatus({ plan: undefined, planStatus: 'activo' }, now)).toBeUndefined();
  });

  it('only allows writes on trial or active plans, including a suspended plan without dates', () => {
    expect(canOrganizationWrite(organization(), now)).toBe(true);
    expect(
      canOrganizationWrite(
        organization({ planExpiresAt: new Date('2026-10-22T11:59:59.999Z') }),
        now
      )
    ).toBe(false);
    expect(canOrganizationWrite(organization({ planStatus: 'suspendido' }), now)).toBe(false);
    expect(
      canOrganizationWrite(
        organization({ planStatus: 'suspendido', planExpiresAt: null }),
        now
      )
    ).toBe(false);
    expect(canOrganizationWrite({ plan: undefined, planStatus: 'activo' }, now)).toBe(false);
  });
});
