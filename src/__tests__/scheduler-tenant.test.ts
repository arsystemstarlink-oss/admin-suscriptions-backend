import { runDailyJobForOrganization } from '../infrastructure/scheduler';
import { Plan, Subscription, BillingPeriod } from '../domain/entities';

jest.mock('../infrastructure/repositories', () => ({
  billingPeriodRepository: {
    listByOrganization: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  subscriptionRepository: {
    listByOrganization: jest.fn(),
    update: jest.fn(),
  },
  planRepository: {
    getByIdScoped: jest.fn(),
  },
  schedulerConfigRepository: {
    updateConfig: jest.fn(),
  },
  clientRepository: {
    listByOrganization: jest.fn(),
  },
  whatsappMessageRepository: {
    create: jest.fn(),
  },
  organizationRepository: {
    list: jest.fn(),
  },
  domainEventRepository: {
    create: jest.fn(),
  },
}));

jest.mock('../infrastructure/whatsapp-service', () => ({
  whatsappService: {
    sendTemplate: jest.fn(),
  },
}));

jest.mock('../infrastructure/push-service', () => ({
  pushService: {
    sendBroadcastToOrganization: jest.fn(),
  },
}));

import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  schedulerConfigRepository,
  clientRepository,
} from '../infrastructure/repositories';
import { pushService } from '../infrastructure/push-service';

const mockedBillingPeriods = billingPeriodRepository as jest.Mocked<typeof billingPeriodRepository>;
const mockedSubscriptions = subscriptionRepository as jest.Mocked<typeof subscriptionRepository>;
const mockedPlans = planRepository as jest.Mocked<typeof planRepository>;
const mockedSchedulerConfig = schedulerConfigRepository as jest.Mocked<typeof schedulerConfigRepository>;
const mockedClients = clientRepository as jest.Mocked<typeof clientRepository>;
const mockedPush = pushService as jest.Mocked<typeof pushService>;

function makePlan(orgId: string, id = `plan_${orgId}`): Plan {
  return {
    id,
    organizationId: orgId,
    name: 'Plan',
    price: 50,
    description: 'Plan de prueba',
    active: true,
    createdAt: new Date(),
  };
}

function makeSubscription(orgId: string, id = `sub_${orgId}`): Subscription {
  return {
    id,
    organizationId: orgId,
    clientId: `client_${orgId}`,
    planId: `plan_${orgId}`,
    kitNumber: `KIT-${orgId}`,
    billingDay: 5,
    status: 'ACTIVE',
    maxOverduePeriods: 2,
    createdAt: new Date(),
  };
}

function makePeriod(orgId: string, subscriptionId: string, id = `period_${orgId}`): BillingPeriod {
  return {
    id,
    organizationId: orgId,
    subscriptionId,
    periodLabel: 'Junio - Julio',
    startDate: new Date(Date.UTC(2026, 5, 5)),
    endDate: new Date(Date.UTC(2026, 6, 5)),
    amount: 50,
    status: 'PENDING',
    createdAt: new Date(),
  };
}

describe('runDailyJobForOrganization (aislamiento por organización)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 6, 10)));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('debería ejecutar el job solo sobre los datos de la organización indicada', async () => {
    const orgA = 'org_A';
    const subA = makeSubscription(orgA);
    const periodA = makePeriod(orgA, subA.id);

    mockedBillingPeriods.listByOrganization.mockResolvedValue([periodA]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.getByIdScoped.mockResolvedValue(makePlan(orgA));
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: orgA, enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    const result = await runDailyJobForOrganization(orgA);

    expect(mockedBillingPeriods.listByOrganization).toHaveBeenCalledWith('org_A');
    expect(mockedSubscriptions.listByOrganization).toHaveBeenCalledWith('org_A');
    expect(mockedClients.listByOrganization).toHaveBeenCalledWith('org_A');

    expect(result.overdue).toBe(1);
    expect(result.generated).toBe(1);

    const updated = mockedBillingPeriods.update.mock.calls[0][0];
    expect(updated.id).toBe(periodA.id);
    expect(updated.organizationId).toBe('org_A');
    expect(updated.status).toBe('OVERDUE');

    const created = mockedBillingPeriods.create.mock.calls[0][0];
    expect(created.organizationId).toBe('org_A');
    expect(created.status).toBe('PENDING');

    expect(mockedSchedulerConfig.updateConfig).toHaveBeenCalledWith(
      expect.any(Object),
      'org_A'
    );

    expect(mockedPush.sendBroadcastToOrganization).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org_A' })
    );
  });

  it('debería escanear cada organización por separado sin mezclar datos', async () => {
    const subA = makeSubscription('org_A');
    const periodA = makePeriod('org_A', subA.id);
    const subB = makeSubscription('org_B');
    const periodB = makePeriod('org_B', subB.id, 'period_org_B');

    mockedBillingPeriods.listByOrganization
      .mockResolvedValueOnce([periodA])
      .mockResolvedValueOnce([periodB]);
    mockedSubscriptions.listByOrganization
      .mockResolvedValueOnce([subA])
      .mockResolvedValueOnce([subB]);
    mockedPlans.getByIdScoped.mockResolvedValue(makePlan('org_A'));
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'x', enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    await runDailyJobForOrganization('org_A');
    await runDailyJobForOrganization('org_B');

    expect(mockedBillingPeriods.listByOrganization).toHaveBeenNthCalledWith(1, 'org_A');
    expect(mockedBillingPeriods.listByOrganization).toHaveBeenNthCalledWith(2, 'org_B');
    expect(mockedSubscriptions.listByOrganization).toHaveBeenNthCalledWith(1, 'org_A');
    expect(mockedSubscriptions.listByOrganization).toHaveBeenNthCalledWith(2, 'org_B');

    const orgBCreated = mockedBillingPeriods.create.mock.calls[1][0];
    expect(orgBCreated.organizationId).toBe('org_B');
  });

  it('debería marcar OVERDUE solo los períodos vencidos de la org', async () => {
    const subA = makeSubscription('org_A');
    const pendingOverdue = makePeriod('org_A', subA.id, 'p1');
    const pendingFuture = {
      ...makePeriod('org_A', subA.id, 'p2'),
      startDate: new Date(Date.UTC(2026, 6, 5)),
      endDate: new Date(Date.UTC(2026, 7, 5)),
      status: 'PENDING' as const,
    };

    mockedBillingPeriods.listByOrganization.mockResolvedValue([pendingOverdue, pendingFuture]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.getByIdScoped.mockResolvedValue(makePlan('org_A'));
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'org_A', enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    await runDailyJobForOrganization('org_A');

    const updates = mockedBillingPeriods.update.mock.calls.map((c) => c[0]);
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('p1');
    expect(updates[0].status).toBe('OVERDUE');
  });
});
