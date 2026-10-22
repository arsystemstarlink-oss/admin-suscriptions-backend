import { Request, Response, NextFunction } from 'express';
import { BusinessError, Organization } from '../domain/entities';
import { organizationRepository } from '../infrastructure/repositories';
import { requireWritablePlan } from '../api/middleware/organization-plan-access';

jest.mock('../infrastructure/repositories', () => ({
  organizationRepository: {
    getById: jest.fn(),
    refreshExpiredStatus: jest.fn(),
  },
}));

const repository = organizationRepository as jest.Mocked<
  Pick<typeof organizationRepository, 'getById' | 'refreshExpiredStatus'>
>;

const activeOrganization: Organization = {
  id: 'org_1',
  name: 'Org',
  active: true,
  plan: 'basico',
  clientLimit: 30,
  planStatus: 'activo',
  trialEndsAt: null,
  planExpiresAt: new Date('2026-11-01T00:00:00.000Z'),
  clientCount: 2,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

function invoke(method: string, role: 'admin' | 'super-admin' = 'admin') {
  const req = {
    method,
    query: {},
    body: {},
    auth: { userId: 'user_1', role, organizationId: role === 'admin' ? 'org_1' : null },
  } as unknown as Request;
  const next = jest.fn() as jest.MockedFunction<NextFunction>;
  return requireWritablePlan(req, {} as Response, next).then(() => next);
}

describe('requireWritablePlan', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows reads without loading plan state', async () => {
    const next = await invoke('GET');
    expect(next).toHaveBeenCalledWith();
    expect(repository.getById).not.toHaveBeenCalled();
  });

  it('does not restrict super-admin writes', async () => {
    const next = await invoke('POST', 'super-admin');
    expect(next).toHaveBeenCalledWith();
    expect(repository.getById).not.toHaveBeenCalled();
  });

  it('allows writes for a configured plan that has not expired', async () => {
    jest.spyOn(organizationRepository, 'getById').mockResolvedValue(activeOrganization);
    jest.spyOn(organizationRepository, 'refreshExpiredStatus').mockResolvedValue(activeOrganization);

    const next = await invoke('PUT');
    expect(next).toHaveBeenCalledWith();
  });

  it('blocks writes when the organization is expired', async () => {
    const expired = { ...activeOrganization, planStatus: 'vencido' as const };
    jest.spyOn(organizationRepository, 'getById').mockResolvedValue(expired);
    jest.spyOn(organizationRepository, 'refreshExpiredStatus').mockResolvedValue(expired);

    const next = await invoke('DELETE');
    const error = next.mock.calls[0][0] as BusinessError;
    expect(error.code).toBe('PLAN_READ_ONLY');
  });
});
