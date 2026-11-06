import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createFakeFirestore } from './support/fake-firestore';
import publicRouter from '../api/routes/public';
import billingPeriodsRouter from '../api/routes/billing-periods';
import clientsRouter from '../api/routes/clients';
import subscriptionsRouter from '../api/routes/subscriptions';
import planReportsRouter from '../api/routes/organization-plan-payment-reports';
import whatsappRouter from '../api/routes/whatsapp';
import { errorHandler } from '../api/middleware/error-handler';
import { parsePagination } from '../api/validation';
import { clientRepository, subscriptionRepository, userRepository, whatsappConversationRepository } from '../infrastructure/repositories';
import { pushService } from '../infrastructure/push-service';
import { Client, User, WhatsAppMessage } from '../domain/entities';

jest.mock('../infrastructure/firebase', () => {
  const { createFakeFirestore: create } = jest.requireActual('./support/fake-firestore');
  const fake = create();
  return {
    __fake: fake,
    getFirestore: () => fake.db,
    admin: fake.admin,
    syncUserCustomClaims: jest.fn(async () => undefined),
  };
});
jest.mock('../infrastructure/stats-service', () => ({ scheduleStatsRecompute: jest.fn() }));
jest.mock('../infrastructure/badge-cache', () => ({ invalidateBadges: jest.fn() }));
jest.mock('../infrastructure/scheduler', () => ({ syncOrganizationSchedule: jest.fn(async () => undefined) }));
jest.mock('../infrastructure/push-service', () => ({
  pushService: { sendBroadcastToOrganization: jest.fn(async () => 0), sendBroadcast: jest.fn(async () => 0) },
}));

const fake: ReturnType<typeof createFakeFirestore> = jest.requireMock('../infrastructure/firebase').__fake;

const ORG = 'org_1';
const now = new Date();
const paidAtText = now.toISOString().slice(0, 10);
const organization = {
  id: ORG,
  name: 'ORG',
  slug: 'org',
  active: true,
  plan: 'pro',
  clientLimit: 75,
  planStatus: 'activo',
  trialEndsAt: null,
  planExpiresAt: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)),
  clientCount: 0,
  createdAt: new Date(0),
  twilio: { accountSid: 'AC1', authToken: 't', phoneNumber: '+584111111111', enabled: true },
};
const client: Client = {
  id: 'client_1',
  organizationId: ORG,
  firstName: 'Ana',
  lastName: 'López',
  phone: '+584120000000',
  dni: 'V-12345678',
  createdAt: new Date(1000),
};
const subscription = {
  id: 'sub_1',
  organizationId: ORG,
  clientId: client.id,
  planId: 'plan_1',
  kitNumber: 'KIT',
  billingDay: 1,
  status: 'ACTIVE',
  maxOverduePeriods: 2,
  createdAt: new Date(0),
};
const period = {
  id: 'period_1',
  organizationId: ORG,
  subscriptionId: subscription.id,
  periodLabel: 'Ciclo',
  startDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  endDate: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  amount: 50,
  status: 'PENDING',
  createdAt: new Date(0),
};
const pendingReport = {
  id: 'report_1',
  organizationId: ORG,
  clientId: client.id,
  subscriptionId: subscription.id,
  billingPeriodId: period.id,
  amount: 50,
  paymentMethod: 'TRANSFER',
  paidAt: now,
  status: 'PENDING',
  createdAt: now,
};

describe('flujos de consistencia', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    process.env.TWILIO_WEBHOOK_VALIDATION = 'false';
    const app = express();
    app.use(express.json());
    app.use('/public', publicRouter);
    app.use('/communications', whatsappRouter);
    app.use((req, _res, next) => {
      (req as Request & { auth: unknown }).auth = { userId: 'user_1', role: 'admin', organizationId: ORG };
      next();
    });
    app.use('/billing-periods', billingPeriodsRouter);
    app.use('/clients', clientsRouter);
    app.use('/subscriptions', subscriptionsRouter);
    app.use('/plan-reports', planReportsRouter);
    app.use(errorHandler);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fake.clear();
    fake.seed('organizations', organization);
    fake.seed('plans', { id: 'plan_1', organizationId: ORG, name: 'Plan', price: 50, description: 'P', active: true, createdAt: new Date(0) });
    fake.seed('clients', client);
    fake.seed('subscriptions', subscription);
    fake.seed('billingPeriods', period);
  });

  const send = (method: string, path: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  describe('reportes de pago', () => {
    const pay = () =>
      send('POST', `/billing-periods/${period.id}/pay`, { paymentMethod: 'CASH', amount: 50, paidAt: paidAtText });
    const report = () =>
      send('POST', `/public/org/${organization.slug}/reports`, {
        dni: client.dni,
        phone: client.phone,
        billingPeriodId: period.id,
        paymentMethod: 'TRANSFER',
        paidAt: paidAtText,
      });

    it('cobrar directamente cierra los reportes pendientes de ese período', async () => {
      fake.seed('paymentReports', pendingReport);
      fake.seed('paymentReports', { ...pendingReport, id: 'report_other', billingPeriodId: 'period_other' });

      const response = await pay();

      expect(response.status).toBe(200);
      expect(fake.read('paymentReports', 'report_1')).toMatchObject({
        status: 'REJECTED',
        reviewedByUserId: 'user_1',
      });
      expect(fake.read('paymentReports', 'report_other')?.status).toBe('PENDING');
    });

    it('dos reportes públicos simultáneos del mismo período crean uno solo', async () => {
      fake.overlapNextTransactions(2);

      const statuses = (await Promise.all([report(), report()])).map((response) => response.status).sort();

      expect(statuses).toEqual([201, 409]);
      expect(fake.all('paymentReports')).toHaveLength(1);
      expect(fake.all('domainEvents').filter((event) => event.type === 'payment_report.created')).toHaveLength(1);
    });

    it('no acepta un reporte de un período pagado mientras se enviaba', async () => {
      fake.overlapNextTransactions(2);

      const [payment, reported] = await Promise.all([pay(), report()]);

      expect(payment.status).toBe(200);
      expect(fake.read('billingPeriods', period.id)?.status).toBe('PAID');
      // Si el reporte llegó a guardarse antes que el pago, el pago lo cerró.
      expect(fake.all('paymentReports').filter((item) => item.status === 'PENDING')).toHaveLength(0);
      expect([201, 409]).toContain(reported.status);
    });
  });

  describe('paginación', () => {
    const seedClients = () => {
      for (let index = 2; index <= 6; index++) {
        fake.seed('clients', {
          ...client,
          id: `client_${index}`,
          firstName: `Ana${index}`,
          dni: undefined,
          createdAt: new Date(index * 1000),
        });
      }
      // Solo los clientes 1, 3 y 5 tienen suscripción activa.
      fake.seed('subscriptions', { ...subscription, id: 'sub_3', clientId: 'client_3' });
      fake.seed('subscriptions', { ...subscription, id: 'sub_5', clientId: 'client_5' });
    };

    it('los filtros se aplican antes de paginar', async () => {
      seedClients();

      const first = await (await send('GET', '/clients?subscriptionStatus=ACTIVE&limit=2')).json();
      const second = await (await send('GET', '/clients?subscriptionStatus=ACTIVE&limit=2&offset=2')).json();

      expect(first.clients.map((item: Client) => item.id)).toEqual(['client_1', 'client_3']);
      expect(first.pagination).toMatchObject({ total: 3, hasMore: true });
      expect(second.clients.map((item: Client) => item.id)).toEqual(['client_5']);
      expect(second.pagination).toMatchObject({ total: 3, hasMore: false });
    });

    it('la búsqueda devuelve la segunda página', async () => {
      seedClients();

      const first = await (await send('GET', '/clients?search=Ana&limit=2')).json();
      const second = await (await send('GET', '/clients?search=Ana&limit=2&offset=2')).json();

      expect(first.clients).toHaveLength(2);
      expect(first.pagination.hasMore).toBe(true);
      expect(second.clients).toHaveLength(2);
      const ids = [...first.clients, ...second.clients].map((item: Client) => item.id);
      expect(new Set(ids).size).toBe(4);
    });

    it.each([
      [{ limit: '-5', offset: '-1' }, { limit: 1, offset: 0 }],
      [{ limit: '99999' }, { limit: 200, offset: 0 }],
      [{ limit: 'abc', offset: 'abc' }, { limit: 50, offset: 0 }],
      [{}, { limit: 50, offset: 0 }],
    ])('acota %j', (query, expected) => {
      expect(parsePagination(query)).toEqual(expected);
    });

    it('un offset negativo no produce un error interno', async () => {
      seedClients();

      const response = await send('GET', '/clients?subscriptionStatus=ACTIVE&offset=-3');

      expect(response.status).toBe(200);
    });
  });

  describe('unicidad', () => {
    const newClient = (id: string): Client => ({ ...client, id, dni: 'V-99999999' });

    it('dos altas simultáneas con la misma cédula crean un solo cliente', async () => {
      fake.overlapNextTransactions(2);

      const results = await Promise.allSettled([
        clientRepository.createWithinPlanLimit(newClient('a')),
        clientRepository.createWithinPlanLimit(newClient('b')),
      ]);

      const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason.code).toBe('DNI_TAKEN');
      expect(fake.all('clients').filter((item) => item.dni === 'V-99999999')).toHaveLength(1);
      expect(fake.read('organizations', ORG)?.clientCount).toBe(1);
    });

    it('la API rechaza una cédula en uso al crear y al editar', async () => {
      fake.seed('clients', { ...client, id: 'client_2', dni: 'V-22222222' });

      const created = await send('POST', '/clients', {
        firstName: 'B',
        lastName: 'C',
        phone: '04121234567',
        dni: client.dni,
      });
      const updated = await send('PUT', '/clients/client_2', { dni: client.dni });
      const sameClient = await send('PUT', `/clients/${client.id}`, { dni: client.dni, firstName: 'Ana María' });

      expect(created.status).toBe(409);
      expect(updated.status).toBe(409);
      expect(sameClient.status).toBe(200);
      expect(fake.read('clients', 'client_2')?.dni).toBe('V-22222222');
    });

    const user = (id: string): User => ({
      id,
      name: id,
      email: 'mismo@example.com',
      password: 'hash',
      role: 'admin',
      organizationId: ORG,
      createdAt: new Date(0),
    });

    it('dos altas simultáneas con el mismo email crean un solo usuario', async () => {
      fake.overlapNextTransactions(2);

      const results = await Promise.allSettled([
        userRepository.createWithUniqueEmail(user('a')),
        userRepository.createWithUniqueEmail(user('b')),
      ]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(fake.all('users')).toHaveLength(1);
    });

    it('editar el email rechaza uno en uso pero no el propio', async () => {
      fake.seed('users', user('a'));
      fake.seed('users', { ...user('b'), email: 'otro@example.com' });

      await expect(
        userRepository.updateWithUniqueEmail({ ...user('b'), email: 'mismo@example.com' })
      ).rejects.toMatchObject({ code: 'EMAIL_TAKEN' });
      await expect(userRepository.updateWithUniqueEmail(user('a'))).resolves.toBeUndefined();
    });
  });

  describe('respuestas', () => {
    it('el listado de suscripciones calcula la etiqueta del período actual', async () => {
      fake.seed('subscriptions', {
        ...subscription,
        currentPeriodId: period.id,
        currentPeriodStartDate: new Date(Date.UTC(2026, 0, 5)),
        currentPeriodEndDate: new Date(Date.UTC(2026, 1, 5)),
        currentPeriodStatus: 'PENDING',
      });

      const response = await send('GET', '/subscriptions?search=KIT');
      const { subscriptions } = await response.json();

      expect(subscriptions[0].currentPeriod.periodLabel).toBe('Enero - Febrero');
    });

    describe('filtros por vencer y pendientes', () => {
      const dayFromNow = (days: number) =>
        new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + days));
      const seedSub = (id: string, fields: Record<string, unknown>) =>
        fake.seed('subscriptions', {
          ...subscription,
          id,
          kitNumber: `KIT-${id}`,
          currentPeriodId: `period_${id}`,
          currentPeriodStartDate: dayFromNow(-20),
          ...fields,
        });
      const idsFor = async (query: string) => {
        const response = await send('GET', `/subscriptions?${query}`);
        const { subscriptions, pagination } = await response.json();
        return { ids: subscriptions.map((sub: { id: string }) => sub.id), total: pagination.total };
      };

      beforeEach(() => {
        seedSub('later', { currentPeriodStatus: 'PENDING', currentPeriodEndDate: dayFromNow(5), pendingPeriods: 1 });
        seedSub('soon', { currentPeriodStatus: 'PENDING', currentPeriodEndDate: dayFromNow(1), pendingPeriods: 1 });
        seedSub('far', { currentPeriodStatus: 'PENDING', currentPeriodEndDate: dayFromNow(20), pendingPeriods: 1 });
        seedSub('paid', { currentPeriodStatus: 'PAID', currentPeriodEndDate: dayFromNow(2), pendingPeriods: 0 });
        seedSub('off', { status: 'SUSPENDED', currentPeriodStatus: 'PENDING', currentPeriodEndDate: dayFromNow(1), pendingPeriods: 1 });
      });

      it('en una búsqueda, "por vencer" deja solo lo que vence pronto, de lo más próximo a lo más lejano', async () => {
        expect(await idsFor('search=KIT&expiring=true')).toEqual({ ids: ['soon', 'later'], total: 2 });
      });

      it('en una búsqueda, "pendientes" excluye pagadas y suspendidas', async () => {
        const { ids, total } = await idsFor('search=KIT&pending=true');

        expect([...ids].sort()).toEqual(['far', 'later', 'soon']);
        expect(total).toBe(3);
      });

      it('filtra las suscripciones de un cliente sin requerir un índice con clientId', async () => {
        const page = jest.spyOn(subscriptionRepository, 'listByClientNamePage');

        expect(await idsFor(`clientId=${client.id}&expiring=true`)).toEqual({ ids: ['soon', 'later'], total: 2 });
        expect(page).not.toHaveBeenCalled();
        page.mockRestore();
      });

      it('con estado suspendido devuelve vacío sin consultar', async () => {
        const expiringPage = jest.spyOn(subscriptionRepository, 'listExpiringPage');

        expect(await idsFor('status=SUSPENDED&expiring=true')).toEqual({ ids: [], total: 0 });
        expect(await idsFor('status=SUSPENDED&pending=true')).toEqual({ ids: [], total: 0 });
        expect(expiringPage).not.toHaveBeenCalled();
        expiringPage.mockRestore();
      });

      it('sin búsqueda delega en la consulta paginada que corresponde', async () => {
        const empty = { items: [], total: 0, hasMore: false };
        const expiringPage = jest.spyOn(subscriptionRepository, 'listExpiringPage').mockResolvedValue(empty);
        const namePage = jest.spyOn(subscriptionRepository, 'listByClientNamePage').mockResolvedValue(empty);

        await idsFor('expiring=true&hasOverduePeriods=true');
        expect(expiringPage).toHaveBeenCalledWith(expect.objectContaining({ organizationId: ORG, hasDebt: true }));
        expect(namePage).not.toHaveBeenCalled();

        await idsFor('pending=true');
        expect(namePage).toHaveBeenCalledWith(
          expect.objectContaining({ organizationId: ORG, status: 'ACTIVE', pendingOnly: true })
        );

        expiringPage.mockRestore();
        namePage.mockRestore();
      });
    });

    it('la cotización de A medida usa el mismo tope que el reporte', async () => {
      const response = await send('GET', '/plan-reports/quote?plan=a-medida');
      const { quote } = await response.json();

      expect(quote.clientLimit).toBe(151);
    });
  });

  describe('WhatsApp', () => {
    const webhook = () =>
      send('POST', '/communications/webhook', {
        From: 'whatsapp:+584120000000',
        To: 'whatsapp:+584111111111',
        Body: 'Hola',
        MessageSid: 'SM_in_1',
      });
    const callback = (status: string) =>
      send('POST', '/communications/status/SM_out_1', { MessageStatus: status, MessageSid: 'SM_out_1' });
    const message: WhatsAppMessage = {
      id: 'msg_out',
      organizationId: ORG,
      phone: '+584120000000',
      direction: 'OUTBOUND',
      messageSid: 'SM_out_1',
      body: 'x',
      status: 'SENT',
      createdAt: now,
    };

    it('un reintento del webhook no duplica el mensaje ni la notificación', async () => {
      const first = await webhook();
      const second = await webhook();

      expect([first.status, second.status]).toEqual([200, 200]);
      expect(fake.all('whatsappMessages')).toHaveLength(1);
      expect(fake.all('whatsappConversations')[0].messageCount).toBe(1);
      expect(pushService.sendBroadcastToOrganization).toHaveBeenCalledTimes(1);
    });

    it('un estado atrasado no pisa uno más avanzado', async () => {
      fake.seed('whatsappMessages', message);

      await callback('read');
      await callback('delivered');
      await callback('sent');

      expect(fake.read('whatsappMessages', message.id)?.status).toBe('READ');
    });

    it('un estado que avanza se guarda', async () => {
      fake.seed('whatsappMessages', message);

      await callback('delivered');
      expect(fake.read('whatsappMessages', message.id)?.status).toBe('DELIVERED');

      await callback('failed');
      expect(fake.read('whatsappMessages', message.id)?.status).toBe('FAILED');
    });

    it('marcar como leído no borra un mensaje entrante simultáneo', async () => {
      const inbound = (id: string): WhatsAppMessage => ({ ...message, id, messageSid: id, direction: 'INBOUND', createdAt: new Date() });
      await whatsappConversationRepository.upsertFromMessage(inbound('m1'), ORG);
      fake.overlapNextTransactions(2);

      await Promise.all([
        whatsappConversationRepository.markRead(ORG, message.phone),
        whatsappConversationRepository.upsertFromMessage(inbound('m2'), ORG),
      ]);

      const conversation = fake.all('whatsappConversations')[0];
      expect(conversation.messageCount).toBe(2);
    });

    it('varios mensajes de un lote se suman a la conversación', async () => {
      const outbound = (id: string): WhatsAppMessage => ({ ...message, id, messageSid: id });

      await whatsappConversationRepository.upsertManyFromMessages([outbound('m1'), outbound('m2')], ORG);

      expect(fake.all('whatsappConversations')[0].messageCount).toBe(2);
    });
  });
});
