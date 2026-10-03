jest.mock('../api/middleware/request-id', () => ({
  recordDocReads: jest.fn(),
  recordWrite: jest.fn(),
}));

const mockSet = jest.fn();
const mockGet = jest.fn();
const mockDelete = jest.fn();

jest.mock('../infrastructure/firebase', () => ({
  getFirestore: jest.fn(() => ({
    collection: jest.fn(() => ({
      doc: jest.fn(() => ({ set: mockSet, get: mockGet, delete: mockDelete })),
    })),
  })),
  admin: { firestore: { FieldValue: { delete: jest.fn() } } },
}));

jest.mock('../infrastructure/repositories', () => ({
  clientRepository: { countWhere: jest.fn() },
  planRepository: { countWhere: jest.fn() },
  subscriptionRepository: { countWhere: jest.fn() },
  billingPeriodRepository: { countWhere: jest.fn(), sumWhere: jest.fn() },
}));

import {
  clientRepository,
  planRepository,
  subscriptionRepository,
  billingPeriodRepository,
} from '../infrastructure/repositories';
import { computeOrganizationStats } from '../infrastructure/stats-service';

const mockedClients = clientRepository as jest.Mocked<typeof clientRepository>;
const mockedPlans = planRepository as jest.Mocked<typeof planRepository>;
const mockedSubs = subscriptionRepository as jest.Mocked<typeof subscriptionRepository>;
const mockedPeriods = billingPeriodRepository as jest.Mocked<typeof billingPeriodRepository>;

describe('stats-service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('compone organizationStats a partir de las agregaciones y calcula totalDebt', async () => {
    mockedClients.countWhere.mockResolvedValue(30);
    mockedPlans.countWhere.mockResolvedValueOnce(4).mockResolvedValueOnce(3);
    mockedSubs.countWhere
      .mockResolvedValueOnce(34)
      .mockResolvedValueOnce(28)
      .mockResolvedValueOnce(6);
    mockedPeriods.countWhere
      .mockResolvedValueOnce(400)
      .mockResolvedValueOnce(360)
      .mockResolvedValueOnce(30)
      .mockResolvedValueOnce(10);
    mockedPeriods.sumWhere
      .mockResolvedValueOnce(18000)
      .mockResolvedValueOnce(1500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(1200);

    const stats = await computeOrganizationStats('org_A');

    expect(stats.organizationId).toBe('org_A');
    expect(stats.clients.total).toBe(30);
    expect(stats.plans).toEqual({ total: 4, active: 3 });
    expect(stats.subscriptions).toEqual({ total: 34, active: 28, suspended: 6 });
    expect(stats.billingPeriods).toEqual({ total: 400, paid: 360, pending: 30, overdue: 10 });
    expect(stats.financial.totalIncome).toBe(18000);
    expect(stats.financial.totalPending).toBe(1500);
    expect(stats.financial.totalOverdue).toBe(500);
    expect(stats.financial.monthlyIncome).toBe(1200);
    expect(stats.financial.totalDebt).toBe(1500 + 500);
  });

  it('normaliza Timestamps de Firestore al leer organizationStats', async () => {
    const { Timestamp } = jest.requireActual('firebase-admin/firestore');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getOrganizationStats } = require('../infrastructure/stats-service');
    const ts = Timestamp.fromDate(new Date('2026-09-15T12:00:00.000Z'));
    mockGet.mockResolvedValueOnce({
      exists: true,
      data: () => ({
        clients: { total: 1 },
        plans: { total: 1, active: 1 },
        subscriptions: { total: 1, active: 1, suspended: 0 },
        billingPeriods: { total: 1, paid: 0, pending: 1, overdue: 0 },
        financial: { monthlyIncome: 0, totalIncome: 0, totalPending: 50, totalOverdue: 0, totalDebt: 50 },
        updatedAt: ts,
      }),
    });

    const stats = await getOrganizationStats('org_A');

    expect(stats.updatedAt).toBeInstanceOf(Date);
    expect(stats.updatedAt.toISOString()).toBe('2026-09-15T12:00:00.000Z');
  });
});