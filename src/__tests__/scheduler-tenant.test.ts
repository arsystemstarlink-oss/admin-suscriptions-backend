import { runDailyJobForOrganization } from '../infrastructure/scheduler';
import { Plan, Subscription, BillingPeriod } from '../domain/entities';

jest.mock('../infrastructure/repositories', () => ({
  billingPeriodRepository: {
    listByOrganization: jest.fn(),
    listByOrganizationAndStatus: jest.fn(),
    getByIdScoped: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
  },
  subscriptionRepository: {
    listByOrganization: jest.fn(),
    update: jest.fn(),
  },
  planRepository: {
    listByOrganization: jest.fn(),
    getByIdScoped: jest.fn(),
  },
  schedulerConfigRepository: {
    updateConfig: jest.fn(),
    getConfig: jest.fn(),
  },
  clientRepository: {
    listByOrganization: jest.fn(),
  },
  whatsappMessageRepository: {
    create: jest.fn(),
  },
  whatsappConversationRepository: {
    upsertFromMessage: jest.fn(),
  },
  organizationRepository: {
    getById: jest.fn(),
  },
  domainEventRepository: {
    create: jest.fn(),
  },
  schedulerLogRepository: {
    create: jest.fn(),
    listByOrganization: jest.fn(),
    listPage: jest.fn(),
  },
  jobLockRepository: {
    acquire: jest.fn(),
    release: jest.fn(),
  },
}));

jest.mock('../infrastructure/whatsapp-service', () => ({
  whatsappService: {
    sendTemplate: jest.fn(),
  },
  resolveTwilioCredentials: jest.fn(() => ({
    accountSid: 'AC_test',
    authToken: 'token_test',
    phoneNumber: '+584111111111',
  })),
  extractTwilioError: jest.fn(),
}));

jest.mock('../infrastructure/push-service', () => ({
  pushService: {
    sendBroadcastToOrganization: jest.fn(),
  },
}));

jest.mock('../infrastructure/stats-service', () => ({
  scheduleStatsRecompute: jest.fn(),
}));

import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  schedulerConfigRepository,
  clientRepository,
  jobLockRepository,
} from '../infrastructure/repositories';
import { pushService } from '../infrastructure/push-service';

const mockedBillingPeriods = billingPeriodRepository as jest.Mocked<typeof billingPeriodRepository>;
const mockedSubscriptions = subscriptionRepository as jest.Mocked<typeof subscriptionRepository>;
const mockedPlans = planRepository as jest.Mocked<typeof planRepository>;
const mockedSchedulerConfig = schedulerConfigRepository as jest.Mocked<typeof schedulerConfigRepository>;
const mockedClients = clientRepository as jest.Mocked<typeof clientRepository>;
const mockedJobLock = jobLockRepository as jest.Mocked<typeof jobLockRepository>;
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

function setPeriods(periods: BillingPeriod[]): void {
  mockedBillingPeriods.listByOrganization.mockResolvedValue(periods);
  mockedBillingPeriods.listByOrganizationAndStatus.mockImplementation(
    async (_org: string, status: string) => periods.filter((p) => p.status === status)
  );
}

describe('runDailyJobForOrganization (aislamiento por organización)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 6, 10)));
    mockedJobLock.acquire.mockResolvedValue(true);
    mockedJobLock.release.mockResolvedValue();
    mockedBillingPeriods.getByIdScoped.mockResolvedValue(undefined);
    mockedSchedulerConfig.getConfig.mockResolvedValue({
      id: 'org_A',
      enabled: true,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('debería ejecutar el job solo sobre los datos de la organización indicada', async () => {
    const orgA = 'org_A';
    const subA = makeSubscription(orgA);
    const periodA = makePeriod(orgA, subA.id);

    setPeriods([periodA]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: orgA, enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    const result = await runDailyJobForOrganization(orgA);

    expect(mockedBillingPeriods.listByOrganizationAndStatus).toHaveBeenCalledWith('org_A', 'PENDING');
    expect(mockedBillingPeriods.listByOrganizationAndStatus).toHaveBeenCalledWith('org_A', 'OVERDUE');
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

    mockedBillingPeriods.listByOrganizationAndStatus.mockImplementation(
      async (org: string, status: string) => {
        const map: Record<string, BillingPeriod[]> = { org_A: [periodA], org_B: [periodB] };
        return (map[org] || []).filter((p) => p.status === status);
      }
    );
    mockedSubscriptions.listByOrganization
      .mockResolvedValueOnce([subA])
      .mockResolvedValueOnce([subB]);
    mockedPlans.listByOrganization.mockImplementation((orgId: string) => [makePlan(orgId)]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'x', enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    await runDailyJobForOrganization('org_A');
    await runDailyJobForOrganization('org_B');

    expect(mockedBillingPeriods.listByOrganizationAndStatus).toHaveBeenNthCalledWith(1, 'org_A', 'PENDING');
    expect(mockedBillingPeriods.listByOrganizationAndStatus).toHaveBeenNthCalledWith(3, 'org_B', 'PENDING');
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

    setPeriods([pendingOverdue, pendingFuture]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan('org_A')]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'org_A', enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    await runDailyJobForOrganization('org_A');

    const updates = mockedBillingPeriods.update.mock.calls.map((c) => c[0]);
    const overdueUpdates = updates.filter((u) => u.status === 'OVERDUE');
    expect(overdueUpdates).toHaveLength(1);
    expect(overdueUpdates[0].id).toBe('p1');
  });

  it('el run manual de una org ejecuta el job aunque su config tenga enabled=false', async () => {
    mockedSchedulerConfig.getConfig.mockImplementation(async (organizationId: string) => ({
      id: organizationId,
      enabled: false,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    }));
    setPeriods([]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedPlans.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'org_A', enabled: false, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    const result = await runDailyJobForOrganization('org_A');

    expect(result.skipped).toBeFalsy();
    expect(mockedBillingPeriods.listByOrganizationAndStatus).toHaveBeenCalledWith('org_A', 'PENDING');
    expect(mockedSchedulerConfig.updateConfig).toHaveBeenCalledWith(expect.any(Object), 'org_A');
  });

  it('omite la ejecución cuando el lock de la organización está activo', async () => {
    mockedJobLock.acquire.mockResolvedValue(false);
    mockedBillingPeriods.listByOrganization.mockResolvedValue([]);

    const result = await runDailyJobForOrganization('org_A');

    expect(result.skipped).toBe(true);
    expect(result.overdue).toBe(0);
    expect(mockedBillingPeriods.listByOrganizationAndStatus).not.toHaveBeenCalled();
    expect(mockedSchedulerConfig.updateConfig).not.toHaveBeenCalled();
    expect(mockedJobLock.release).not.toHaveBeenCalled();
  });

  it('no duplica ni notifica un ciclo futuro pagado por adelantado', async () => {
    const orgA = 'org_A';
    const subA = makeSubscription(orgA);
    const paidAnchor: BillingPeriod = {
      ...makePeriod(orgA, subA.id, 'p_anchor'),
      endDate: new Date(Date.UTC(2026, 6, 5)),
      status: 'PAID',
      paidAt: new Date(Date.UTC(2026, 5, 20)),
      paymentMethod: 'CASH',
    };
    const advancePeriod: BillingPeriod = {
      ...makePeriod(orgA, subA.id, 'p_advance'),
      startDate: new Date(Date.UTC(2026, 6, 5)),
      endDate: new Date(Date.UTC(2026, 7, 5)),
      amount: 50,
      status: 'PAID',
      paidAt: new Date(Date.UTC(2026, 6, 10)),
      paymentMethod: 'CASH',
    };

    setPeriods([paidAnchor, advancePeriod]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedClients.listByOrganization.mockResolvedValue([
      { id: `client_${orgA}`, organizationId: orgA, firstName: 'Ana', lastName: 'López', phone: '+584123456789', createdAt: new Date() },
    ]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: orgA, enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    const result = await runDailyJobForOrganization(orgA);

    expect(result.generated).toBe(0);
    expect(result.notifications).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(mockedBillingPeriods.create).not.toHaveBeenCalled();
  });
});
