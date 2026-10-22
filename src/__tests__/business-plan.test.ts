import {
  isPlanExpired,
  validatePlanConfiguration,
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
    ['basico', 30],
    ['pro', 150],
    ['negocio', 300],
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

  it('requires custom plans to exceed 300 clients', () => {
    expect(() =>
      validatePlanConfiguration({
        plan: 'a-medida',
        clientLimit: 300,
        planStatus: 'activo',
        planExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
      })
    ).toThrow('al menos 301');
  });

  it('only permits a dated trial on the Basic plan', () => {
    expect(() =>
      validatePlanConfiguration({
        plan: 'pro',
        clientLimit: 150,
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
});
