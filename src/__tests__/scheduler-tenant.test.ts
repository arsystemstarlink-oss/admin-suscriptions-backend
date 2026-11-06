import { runDailyJobForOrganization } from '../infrastructure/scheduler';
import { Plan, Subscription, BillingPeriod, Organization, WhatsAppMessage } from '../domain/entities';

jest.mock('../infrastructure/repositories', () => ({
  billingPeriodRepository: {
    listByOrganization: jest.fn(),
    listPendingOverdueCandidates: jest.fn(),
    listReminderWindowCandidates: jest.fn(),
    listBySubscriptionIds: jest.fn(),
    listByIds: jest.fn(),
    getByIdScoped: jest.fn(),
    update: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
    createMany: jest.fn(),
  },
  subscriptionRepository: {
    listByOrganization: jest.fn(),
    listByIds: jest.fn(),
    listGenerationCandidates: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
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
    createMany: jest.fn(),
    existsOutboundMessageSince: jest.fn(),
    listOutboundSince: jest.fn(),
  },
  whatsappConversationRepository: {
    upsertFromMessage: jest.fn(),
    upsertManyFromMessages: jest.fn(),
  },
  organizationRepository: {
    getById: jest.fn(),
    refreshExpiredStatus: jest.fn(async (organization: Organization) => organization),
  },
  domainEventRepository: {
    create: jest.fn(),
    createMany: jest.fn(),
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
  flushStatsRecompute: jest.fn(),
}));

jest.mock('../infrastructure/billing-transactions', () => ({
  subscriptionTransactions: { applyDailyJobChange: jest.fn(async () => 'applied') },
}));

import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  schedulerConfigRepository,
  clientRepository,
  jobLockRepository,
  organizationRepository,
  schedulerLogRepository,
  whatsappMessageRepository,
} from '../infrastructure/repositories';
import { pushService } from '../infrastructure/push-service';
import { whatsappService } from '../infrastructure/whatsapp-service';
import { subscriptionTransactions } from '../infrastructure/billing-transactions';

const mockedBillingPeriods = billingPeriodRepository as jest.Mocked<typeof billingPeriodRepository>;
const mockedSubscriptions = subscriptionRepository as jest.Mocked<typeof subscriptionRepository>;
const mockedPlans = planRepository as jest.Mocked<typeof planRepository>;
const mockedSchedulerConfig = schedulerConfigRepository as jest.Mocked<typeof schedulerConfigRepository>;
const mockedClients = clientRepository as jest.Mocked<typeof clientRepository>;
const mockedJobLock = jobLockRepository as jest.Mocked<typeof jobLockRepository>;
const mockedPush = pushService as jest.Mocked<typeof pushService>;
const mockedOrganizations = organizationRepository as jest.Mocked<typeof organizationRepository>;
const mockedWhatsApp = whatsappService as jest.Mocked<typeof whatsappService>;
const mockedWhatsAppMessages = whatsappMessageRepository as jest.Mocked<typeof whatsappMessageRepository>;
const mockedSchedulerLogs = schedulerLogRepository as jest.Mocked<typeof schedulerLogRepository>;
const mockedApplyChange = subscriptionTransactions.applyDailyJobChange as jest.Mock;
const firstChange = () => mockedApplyChange.mock.calls[0][0];

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

function makeOrganization(id: string): Organization {
  return {
    id,
    name: `Org ${id}`,
    active: true,
    plan: 'basico',
    clientLimit: 30,
    planStatus: 'activo',
    trialEndsAt: null,
    planExpiresAt: new Date(Date.UTC(2027, 0, 1)),
    clientCount: 0,
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
  mockedBillingPeriods.listPendingOverdueCandidates.mockImplementation(async () =>
    periods.filter((p) => p.status === 'PENDING')
  );
  mockedBillingPeriods.listBySubscriptionIds.mockImplementation(async () => periods);
}

describe('runDailyJobForOrganization (aislamiento por organización)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date(Date.UTC(2026, 6, 10)));
    mockedJobLock.acquire.mockResolvedValue(true);
    mockedJobLock.release.mockResolvedValue();
    mockedBillingPeriods.getByIdScoped.mockResolvedValue(undefined);
    mockedBillingPeriods.listByIds.mockResolvedValue([]);
    mockedBillingPeriods.listReminderWindowCandidates.mockResolvedValue([]);
    mockedSubscriptions.listGenerationCandidates.mockResolvedValue([]);
    mockedWhatsAppMessages.existsOutboundMessageSince.mockResolvedValue(false);
    mockedWhatsAppMessages.listOutboundSince.mockResolvedValue([]);
    mockedOrganizations.getById.mockResolvedValue(makeOrganization('org_A'));
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
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: orgA, enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    const result = await runDailyJobForOrganization(orgA);

    expect(mockedBillingPeriods.listPendingOverdueCandidates).toHaveBeenCalledWith(
      'org_A',
      expect.any(Date),
      500
    );
    expect(mockedBillingPeriods.listBySubscriptionIds).toHaveBeenCalledWith(
      expect.arrayContaining([subA.id]),
      'org_A'
    );
    expect(mockedSubscriptions.listByIds).toHaveBeenCalledWith(
      expect.arrayContaining([subA.id]),
      'org_A'
    );
    expect(mockedClients.listByOrganization).toHaveBeenCalledWith('org_A');

    expect(result.overdue).toBe(1);
    expect(result.generated).toBe(1);

    expect(firstChange().overduePeriodIds).toEqual([periodA.id]);

    const created = firstChange().createdPeriods[0];
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

    mockedBillingPeriods.listPendingOverdueCandidates.mockImplementation(async (org: string) => {
      const map: Record<string, BillingPeriod[]> = { org_A: [periodA], org_B: [periodB] };
      return (map[org] || []).filter((p) => p.status === 'PENDING');
    });
    mockedBillingPeriods.listBySubscriptionIds.mockImplementation(async (ids: string[]) => {
      const all = [periodA, periodB];
      return all.filter((p) => ids.includes(p.subscriptionId));
    });
    mockedSubscriptions.listByIds.mockImplementation(async (ids: string[]) => {
      const all = [subA, subB];
      return all.filter((s) => ids.includes(s.id));
    });
    mockedPlans.listByOrganization.mockImplementation((orgId: string) => [makePlan(orgId)]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'x', enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    await runDailyJobForOrganization('org_A');
    await runDailyJobForOrganization('org_B');

    expect(mockedBillingPeriods.listPendingOverdueCandidates).toHaveBeenNthCalledWith(
      1,
      'org_A',
      expect.any(Date),
      500
    );
    expect(mockedBillingPeriods.listPendingOverdueCandidates).toHaveBeenNthCalledWith(
      2,
      'org_B',
      expect.any(Date),
      500
    );
    expect(mockedSubscriptions.listByIds).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([subA.id]),
      'org_A'
    );
    expect(mockedSubscriptions.listByIds).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([subB.id]),
      'org_B'
    );

    const orgBCreated = mockedApplyChange.mock.calls[1][0].createdPeriods[0];
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
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedSubscriptions.listByOrganization.mockResolvedValue([subA]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan('org_A')]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({ id: 'org_A', enabled: true, cronSchedule: '0 0 * * *', updatedAt: new Date() });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    await runDailyJobForOrganization('org_A');

    expect(mockedApplyChange.mock.calls.flatMap((c) => c[0].overduePeriodIds)).toEqual(['p1']);
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
    expect(mockedBillingPeriods.listPendingOverdueCandidates).toHaveBeenCalledWith(
      'org_A',
      expect.any(Date),
      500
    );
    expect(mockedSchedulerConfig.updateConfig).toHaveBeenCalledWith(expect.any(Object), 'org_A');
  });

  it('omite la ejecución cuando el lock de la organización está activo', async () => {
    mockedJobLock.acquire.mockResolvedValue(false);
    mockedBillingPeriods.listByOrganization.mockResolvedValue([]);

    const result = await runDailyJobForOrganization('org_A');

    expect(result.skipped).toBe(true);
    expect(result.overdue).toBe(0);
    expect(mockedBillingPeriods.listPendingOverdueCandidates).not.toHaveBeenCalled();
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
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedSubscriptions.listGenerationCandidates.mockResolvedValue([subA]);
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

  it('envía recordatorios en los días configurados por la organización', async () => {
    const orgA = 'org_A';
    const subA = {
      ...makeSubscription(orgA),
      currentPeriodId: 'period_reminder',
    };
    const period = {
      ...makePeriod(orgA, subA.id, 'period_reminder'),
      startDate: new Date(Date.UTC(2026, 6, 5)),
      endDate: new Date(Date.UTC(2026, 6, 15)),
    };
    const organization: Organization = {
      ...makeOrganization(orgA),
      twilio: {
        authToken: 'token_org_A',
        phoneNumber: '+584111111111',
      },
      whatsappNotifications: {
        rules: {
          reminderDaysBefore: [5, 3],
          dueDateWarningEnabled: true,
          suspensionNoticeEnabled: true,
        },
        templates: { reminder: 'HX_org_A_reminder' },
      },
    };

    mockedOrganizations.getById.mockResolvedValue(organization);
    mockedBillingPeriods.listPendingOverdueCandidates.mockResolvedValue([]);
    mockedBillingPeriods.listReminderWindowCandidates.mockResolvedValue([period]);
    mockedBillingPeriods.listBySubscriptionIds.mockResolvedValue([period]);
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedClients.listByOrganization.mockResolvedValue([
      {
        id: `client_${orgA}`,
        organizationId: orgA,
        firstName: 'Ana',
        lastName: 'López',
        phone: '+584123456789',
        createdAt: new Date(),
      },
    ]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({
      id: orgA,
      enabled: true,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);
    mockedWhatsApp.sendTemplate.mockResolvedValue('SM_reminder');

    const result = await runDailyJobForOrganization(orgA);

    expect(result.notifications).toBe(1);
    expect(mockedWhatsApp.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'HX_org_A_reminder' }),
      organization
    );
    expect(mockedWhatsAppMessages.listOutboundSince).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: orgA })
    );
  });

  it('procesa recordatorios aunque otra suscripción SUSPENDED tenga un PENDING vencido', async () => {
    const orgA = 'org_A';
    const suspendedSub = {
      ...makeSubscription(orgA, 'sub_suspended'),
      status: 'SUSPENDED' as const,
      currentPeriodId: 'period_suspended',
    };
    const suspendedPeriod: BillingPeriod = {
      ...makePeriod(orgA, suspendedSub.id, 'period_suspended'),
      endDate: new Date(Date.UTC(2026, 6, 5)),
      status: 'PENDING',
    };
    const activeSub = { ...makeSubscription(orgA, 'sub_active'), currentPeriodId: 'period_active' };
    const activePeriod: BillingPeriod = {
      ...makePeriod(orgA, activeSub.id, 'period_active'),
      startDate: new Date(Date.UTC(2026, 6, 5)),
      endDate: new Date(Date.UTC(2026, 6, 15)),
      status: 'PENDING',
    };
    const organization: Organization = {
      ...makeOrganization(orgA),
      twilio: { authToken: 'token_org_A', phoneNumber: '+584111111111' },
      whatsappNotifications: {
        rules: { reminderDaysBefore: [5, 3], dueDateWarningEnabled: true, suspensionNoticeEnabled: true },
        templates: { reminder: 'HX_org_A_reminder' },
      },
    };

    mockedOrganizations.getById.mockResolvedValue(organization);
    mockedBillingPeriods.listPendingOverdueCandidates.mockResolvedValue([suspendedPeriod]);
    mockedBillingPeriods.listReminderWindowCandidates.mockResolvedValue([activePeriod]);
    mockedBillingPeriods.listBySubscriptionIds.mockImplementation(async (ids: string[]) =>
      [suspendedPeriod, activePeriod].filter((p) => ids.includes(p.subscriptionId))
    );
    mockedSubscriptions.listByIds.mockImplementation(async (ids: string[]) =>
      [suspendedSub, activeSub].filter((s) => ids.includes(s.id))
    );
    mockedClients.listByOrganization.mockResolvedValue([
      {
        id: activeSub.clientId,
        organizationId: orgA,
        firstName: 'Ana',
        lastName: 'López',
        phone: '+584123456789',
        createdAt: new Date(),
      },
    ]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({
      id: orgA,
      enabled: true,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);
    mockedWhatsApp.sendTemplate.mockResolvedValue('SM_reminder');

    const result = await runDailyJobForOrganization(orgA);

    expect(result.notifications).toBe(1);
    expect(mockedWhatsApp.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'HX_org_A_reminder' }),
      organization
    );
  });

  it('genera el siguiente ciclo cuando el período actual PAID ya venció sin PENDING vencido', async () => {
    const orgA = 'org_A';
    const subA = { ...makeSubscription(orgA), currentPeriodId: 'period_paid' };
    const paidPeriod: BillingPeriod = {
      ...makePeriod(orgA, subA.id, 'period_paid'),
      startDate: new Date(Date.UTC(2026, 5, 5)),
      endDate: new Date(Date.UTC(2026, 6, 5)),
      status: 'PAID',
      paidAt: new Date(Date.UTC(2026, 5, 20)),
      paymentMethod: 'CASH',
    };

    mockedOrganizations.getById.mockResolvedValue(makeOrganization(orgA));
    mockedBillingPeriods.listPendingOverdueCandidates.mockResolvedValue([]);
    mockedBillingPeriods.listBySubscriptionIds.mockResolvedValue([paidPeriod]);
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedSubscriptions.listGenerationCandidates.mockResolvedValue([subA]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedClients.listByOrganization.mockResolvedValue([]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({
      id: orgA,
      enabled: true,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);

    const result = await runDailyJobForOrganization(orgA);

    expect(result.generated).toBe(1);
    const created = firstChange().createdPeriods[0];
    expect(created.subscriptionId).toBe(subA.id);
    expect(created.status).toBe('PENDING');
  });

  it('no reenvía una notificación ya enviada el mismo día (idempotencia)', async () => {
    const orgA = 'org_A';
    const subA = { ...makeSubscription(orgA), currentPeriodId: 'period_reminder' };
    const period: BillingPeriod = {
      ...makePeriod(orgA, subA.id, 'period_reminder'),
      startDate: new Date(Date.UTC(2026, 6, 5)),
      endDate: new Date(Date.UTC(2026, 6, 15)),
      status: 'PENDING',
    };
    const organization: Organization = {
      ...makeOrganization(orgA),
      twilio: { authToken: 'token_org_A', phoneNumber: '+584111111111' },
      whatsappNotifications: {
        rules: { reminderDaysBefore: [5, 3], dueDateWarningEnabled: true, suspensionNoticeEnabled: true },
        templates: { reminder: 'HX_org_A_reminder' },
      },
    };

    mockedOrganizations.getById.mockResolvedValue(organization);
    mockedBillingPeriods.listPendingOverdueCandidates.mockResolvedValue([]);
    mockedBillingPeriods.listReminderWindowCandidates.mockResolvedValue([period]);
    mockedBillingPeriods.listBySubscriptionIds.mockResolvedValue([period]);
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedClients.listByOrganization.mockResolvedValue([
      {
        id: subA.clientId,
        organizationId: orgA,
        firstName: 'Ana',
        lastName: 'López',
        phone: '+584123456789',
        createdAt: new Date(),
      },
    ]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({
      id: orgA,
      enabled: true,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);
    mockedWhatsAppMessages.listOutboundSince.mockResolvedValue([
      {
        id: 'msg_sent',
        organizationId: orgA,
        clientId: subA.clientId,
        phone: '+584123456789',
        direction: 'OUTBOUND',
        messageSid: 'SM_sent',
        body: `[Template: HX_org_A_reminder] Variables: ${JSON.stringify({ '1': 'Ana López', '2': '2026-07-15' })}`,
        templateName: 'HX_org_A_reminder',
        status: 'SENT',
        createdAt: new Date(),
      } as WhatsAppMessage,
    ]);

    const result = await runDailyJobForOrganization(orgA);

    expect(result.notifications).toBe(0);
    expect(mockedWhatsApp.sendTemplate).not.toHaveBeenCalled();
  });

  it('envía el aviso de corte el día del vencimiento aunque reminderDaysBefore esté vacío', async () => {
    const orgA = 'org_A';
    const subA = { ...makeSubscription(orgA), currentPeriodId: 'period_due_today' };
    const period: BillingPeriod = {
      ...makePeriod(orgA, subA.id, 'period_due_today'),
      startDate: new Date(Date.UTC(2026, 5, 10)),
      endDate: new Date(Date.UTC(2026, 6, 10)),
      status: 'PENDING',
    };
    const organization: Organization = {
      ...makeOrganization(orgA),
      twilio: { authToken: 'token_org_A', phoneNumber: '+584111111111' },
      whatsappNotifications: {
        rules: { reminderDaysBefore: [], dueDateWarningEnabled: true, suspensionNoticeEnabled: true },
        templates: { dueDateWarning: 'HX_org_A_warning' },
      },
    };

    mockedOrganizations.getById.mockResolvedValue(organization);
    mockedBillingPeriods.listPendingOverdueCandidates.mockResolvedValue([]);
    mockedBillingPeriods.listReminderWindowCandidates.mockResolvedValue([period]);
    mockedBillingPeriods.listBySubscriptionIds.mockResolvedValue([period]);
    mockedSubscriptions.listByIds.mockResolvedValue([subA]);
    mockedClients.listByOrganization.mockResolvedValue([
      {
        id: subA.clientId,
        organizationId: orgA,
        firstName: 'Ana',
        lastName: 'López',
        phone: '+584123456789',
        createdAt: new Date(),
      },
    ]);
    mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
    mockedSchedulerConfig.updateConfig.mockResolvedValue({
      id: orgA,
      enabled: true,
      cronSchedule: '0 0 * * *',
      updatedAt: new Date(),
    });
    mockedPush.sendBroadcastToOrganization.mockResolvedValue(0);
    mockedWhatsApp.sendTemplate.mockResolvedValue('SM_warning');

    const result = await runDailyJobForOrganization(orgA);

    expect(result.notifications).toBe(1);
    expect(mockedWhatsApp.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateName: 'HX_org_A_warning' }),
      organization
    );
  });

  describe('día de corte y período de activación', () => {
    const orgA = 'org_A';
    // 00:00 en Caracas: la hora real del cron por defecto.
    const CRON_HOUR_UTC = 4;

    function arrangeJob(subscription: Subscription, period: BillingPeriod): void {
      mockedOrganizations.getById.mockResolvedValue({
        ...makeOrganization(orgA),
        twilio: { authToken: 'token_org_A', phoneNumber: '+584111111111' },
        whatsappNotifications: {
          rules: { reminderDaysBefore: [], dueDateWarningEnabled: true, suspensionNoticeEnabled: true },
          templates: { dueDateWarning: 'HX_org_A_warning' },
        },
      });
      mockedBillingPeriods.listPendingOverdueCandidates.mockResolvedValue([period]);
      mockedBillingPeriods.listReminderWindowCandidates.mockResolvedValue([]);
      mockedBillingPeriods.listBySubscriptionIds.mockResolvedValue([period]);
      mockedSubscriptions.listByIds.mockResolvedValue([subscription]);
      mockedClients.listByOrganization.mockResolvedValue([
        {
          id: subscription.clientId,
          organizationId: orgA,
          firstName: 'Ana',
          lastName: 'López',
          phone: '+584123456789',
          createdAt: new Date(),
        },
      ]);
      mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
      mockedWhatsApp.sendTemplate.mockResolvedValue('SM_warning');
    }

    const dueToday = (): BillingPeriod => ({
      ...makePeriod(orgA, `sub_${orgA}`, 'period_due'),
      startDate: new Date(Date.UTC(2026, 5, 10)),
      endDate: new Date(Date.UTC(2026, 6, 10)),
    });

    it('a la hora real del cron avisa el día de corte y no vence ni genera todavía', async () => {
      jest.setSystemTime(new Date(Date.UTC(2026, 6, 10, CRON_HOUR_UTC)));
      arrangeJob({ ...makeSubscription(orgA), currentPeriodId: 'period_due' }, dueToday());

      const result = await runDailyJobForOrganization(orgA);

      expect(result).toMatchObject({ overdue: 0, generated: 0, notifications: 1 });
      expect(mockedWhatsApp.sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({ templateName: 'HX_org_A_warning' }),
        expect.anything()
      );
    });

    it('al día siguiente del corte lo marca vencido y genera el próximo ciclo', async () => {
      jest.setSystemTime(new Date(Date.UTC(2026, 6, 11, CRON_HOUR_UTC)));
      arrangeJob({ ...makeSubscription(orgA), billingDay: 10, currentPeriodId: 'period_due' }, dueToday());

      const result = await runDailyJobForOrganization(orgA);

      expect(result).toMatchObject({ overdue: 1, generated: 1, notifications: 0 });
      const created = firstChange().createdPeriods[0];
      expect(created.startDate).toEqual(new Date(Date.UTC(2026, 6, 10)));
      expect(created.endDate).toEqual(new Date(Date.UTC(2026, 7, 10)));
    });

    it('el período de activación impago sigue PENDING pero no frena la generación', async () => {
      jest.setSystemTime(new Date(Date.UTC(2026, 6, 11, CRON_HOUR_UTC)));
      const activationDate = new Date(Date.UTC(2026, 5, 20));
      const period = { ...dueToday(), startDate: activationDate };
      arrangeJob(
        { ...makeSubscription(orgA), billingDay: 10, activationDate, currentPeriodId: period.id },
        period
      );

      const result = await runDailyJobForOrganization(orgA);

      expect(result).toMatchObject({ overdue: 0, generated: 1, suspended: 0 });
      expect(firstChange().overduePeriodIds).toEqual([]);
      const created = firstChange().createdPeriods[0];
      expect(created.startDate).toEqual(period.endDate);
      expect(created.endDate).toEqual(new Date(Date.UTC(2026, 7, 10)));
      expect(firstChange().subscription.currentPeriodId).toBe(created.id);
    });

    it('una suscripción retenida por su período de activación retoma sin acumular deuda atrasada', async () => {
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 20, CRON_HOUR_UTC)));
      const activationDate = new Date(Date.UTC(2026, 5, 20));
      const period = { ...dueToday(), startDate: activationDate };
      arrangeJob(
        { ...makeSubscription(orgA), billingDay: 10, activationDate, currentPeriodId: period.id },
        period
      );

      const result = await runDailyJobForOrganization(orgA);

      expect(result).toMatchObject({ overdue: 0, generated: 1, suspended: 0 });
      const created = firstChange().createdPeriods[0];
      expect(created.startDate).toEqual(new Date(Date.UTC(2026, 10, 10)));
      expect(created.endDate).toEqual(new Date(Date.UTC(2026, 11, 10)));
    });
  });

  describe('fallos al persistir', () => {
    const orgA = 'org_A';

    const arrangeTwoSubscriptions = () => {
      jest.setSystemTime(new Date(Date.UTC(2026, 6, 11, 4)));
      const client = (id: string) => ({
        id,
        organizationId: orgA,
        firstName: 'Ana',
        lastName: 'López',
        phone: `+58412${id.length}000000`,
        createdAt: new Date(),
      });
      const subscriptions = ['sub_1', 'sub_2'].map((id) => ({
        ...makeSubscription(orgA, id),
        clientId: `client_${id}`,
        maxOverduePeriods: 1,
        billingDay: 10,
      }));
      const periods = subscriptions.map((subscription) => ({
        ...makePeriod(orgA, subscription.id, `period_${subscription.id}`),
        startDate: new Date(Date.UTC(2026, 5, 10)),
        endDate: new Date(Date.UTC(2026, 6, 10)),
      }));
      mockedOrganizations.getById.mockResolvedValue({
        ...makeOrganization(orgA),
        twilio: { authToken: 'token_org_A', phoneNumber: '+584111111111' },
        whatsappNotifications: {
          rules: { reminderDaysBefore: [], dueDateWarningEnabled: false, suspensionNoticeEnabled: true },
          templates: { suspensionNotice: 'HX_suspended' },
        },
      });
      setPeriods(periods);
      mockedSubscriptions.listByIds.mockResolvedValue(subscriptions);
      mockedClients.listByOrganization.mockResolvedValue(subscriptions.map((s) => client(s.clientId)));
      mockedPlans.listByOrganization.mockResolvedValue([makePlan(orgA)]);
      mockedWhatsApp.sendTemplate.mockResolvedValue('SM_notice');
    };

    it('una suscripción que falla no frena a las demás, no se notifica y el log queda en error con lo guardado', async () => {
      arrangeTwoSubscriptions();
      mockedApplyChange.mockRejectedValueOnce(new Error('firestore caído'));
      const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

      await expect(runDailyJobForOrganization(orgA)).rejects.toThrow('firestore caído');

      expect(mockedApplyChange).toHaveBeenCalledTimes(2);
      expect(mockedWhatsApp.sendTemplate).toHaveBeenCalledTimes(1);
      expect(mockedSchedulerLogs.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'error',
          error: 'firestore caído',
          overdue: 1,
          suspended: 1,
          notifications: 1,
        })
      );
      expect(mockedJobLock.release).toHaveBeenCalledWith(orgA, expect.any(String));
      consoleError.mockRestore();
    });

    it('una suscripción que cambió durante la ejecución no cuenta ni notifica', async () => {
      arrangeTwoSubscriptions();
      mockedApplyChange.mockResolvedValueOnce('stale');

      const result = await runDailyJobForOrganization(orgA);

      expect(result).toMatchObject({ overdue: 1, suspended: 1, notifications: 1, skipped: false });
      expect(mockedSchedulerLogs.create).toHaveBeenCalledWith(expect.objectContaining({ status: 'success' }));
    });
  });
});
