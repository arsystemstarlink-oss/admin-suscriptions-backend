import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { getFirestore } from '../../infrastructure/firebase';
import billingPeriodsRouter from '../../api/routes/billing-periods';
import paymentReportsRouter from '../../api/routes/payment-reports';
import subscriptionsRouter from '../../api/routes/subscriptions';
import { errorHandler } from '../../api/middleware/error-handler';
import { subscriptionTransactions } from '../../infrastructure/billing-transactions';
import { clientRepository, organizationRepository } from '../../infrastructure/repositories';
import { runDailyJobForOrganization } from '../../infrastructure/scheduler';
import { BillingPeriod, Organization, Plan, Subscription } from '../../domain/entities';

const PROJECT_ID = 'demo-admin-suscriptions';

// Usa el SDK real. Se detiene si no está el emulador: estas pruebas borran la base de datos.
jest.mock('../../infrastructure/firebase', () => {
  const host = process.env.FIRESTORE_EMULATOR_HOST;
  if (!host) {
    throw new Error('FIRESTORE_EMULATOR_HOST no definido. Ejecuta `npm run test:emulator`.');
  }
  const actual = jest.requireActual('firebase-admin');
  const firebaseAdmin = actual.default ?? actual;
  if (!firebaseAdmin.apps.length) {
    firebaseAdmin.initializeApp({ projectId: 'demo-admin-suscriptions' });
  }
  return {
    admin: firebaseAdmin,
    getFirestore: () => firebaseAdmin.firestore(),
    syncUserCustomClaims: jest.fn(),
  };
});
jest.mock('../../infrastructure/push-service', () => ({
  pushService: { sendBroadcastToOrganization: jest.fn(async () => 0) },
}));
jest.mock('../../infrastructure/badge-cache', () => ({ invalidateBadges: jest.fn() }));
// El recálculo diferido se dispararía tras terminar las pruebas; el inmediato del job sigue siendo real.
jest.mock('../../infrastructure/stats-service', () => ({
  ...jest.requireActual('../../infrastructure/stats-service'),
  scheduleStatsRecompute: jest.fn(),
}));

const ORG = 'org_1';
const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const paidAtText = now.toISOString().slice(0, 10);
const cycleStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
const cycleEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

const plan: Plan = {
  id: 'plan_1',
  organizationId: ORG,
  name: 'Plan',
  price: 50,
  description: 'Plan',
  active: true,
  createdAt: new Date(0),
};
const subscription: Subscription = {
  id: 'sub_1',
  organizationId: ORG,
  clientId: 'client_1',
  planId: plan.id,
  kitNumber: 'KIT',
  billingDay: 1,
  status: 'ACTIVE',
  maxOverduePeriods: 2,
  createdAt: new Date(0),
};
const openPeriod: BillingPeriod = {
  id: 'period_1',
  organizationId: ORG,
  subscriptionId: subscription.id,
  periodLabel: 'Ciclo',
  startDate: cycleStart,
  endDate: cycleEnd,
  amount: 50,
  status: 'PENDING',
  createdAt: new Date(0),
};
const organization: Organization = {
  id: ORG,
  name: 'Org',
  active: true,
  plan: 'pro',
  clientLimit: 75,
  planStatus: 'activo',
  trialEndsAt: null,
  planExpiresAt: new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)),
  clientCount: 1,
  createdAt: new Date(0),
};

const db = () => getFirestore();
const seed = (collection: string, document: { id: string }) =>
  db().collection(collection).doc(document.id).set(document);
const read = async (collection: string, id: string) =>
  (await db().collection(collection).doc(id).get()).data();
const count = async (collection: string, field?: string, value?: unknown) => {
  const query = field ? db().collection(collection).where(field, '==', value) : db().collection(collection);
  return (await query.get()).size;
};

async function clearDatabase(): Promise<void> {
  const url = `http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
  const response = await fetch(url, { method: 'DELETE' });
  if (!response.ok) throw new Error(`No se pudo limpiar el emulador: ${response.status}`);
}

/** Exactamente una petición gana; las demás se rechazan sin error interno. */
function expectSingleWinner(statuses: number[]): void {
  expect(statuses.filter((status) => status === 200)).toHaveLength(1);
  expect(statuses.filter((status) => status !== 200 && status !== 409)).toEqual([]);
}

describe('transacciones contra el emulador de Firestore', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { auth: unknown }).auth = { userId: 'user_1', role: 'admin', organizationId: ORG };
      next();
    });
    app.use('/subscriptions', subscriptionsRouter);
    app.use('/billing-periods', billingPeriodsRouter);
    app.use('/payment-reports', paymentReportsRouter);
    app.use(errorHandler);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(async () => {
    await clearDatabase();
    await seed('plans', plan);
  });

  const send = async (method: string, path: string, body: unknown): Promise<Response> =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const pay = () =>
    send('POST', `/billing-periods/${openPeriod.id}/pay`, { paymentMethod: 'CASH', amount: 50, paidAt: paidAtText });
  const statusesOf = async (requests: Array<Promise<Response>>) =>
    (await Promise.all(requests)).map((response) => response.status);

  describe.each([2, 5])('con %i peticiones simultáneas', (concurrency) => {
    const times = <T>(action: () => T): T[] => Array.from({ length: concurrency }, action);

    it('un período se paga una sola vez', async () => {
      await seed('subscriptions', subscription);
      await seed('billingPeriods', openPeriod);

      expectSingleWinner(await statusesOf(times(pay)));

      expect((await read('billingPeriods', openPeriod.id))?.status).toBe('PAID');
      expect(await count('domainEvents', 'type', 'billing_period.paid')).toBe(1);
    });

    it('un reporte se aprueba una sola vez', async () => {
      await seed('subscriptions', subscription);
      await seed('billingPeriods', openPeriod);
      await seed('paymentReports', {
        id: 'report_1',
        organizationId: ORG,
        clientId: subscription.clientId,
        subscriptionId: subscription.id,
        billingPeriodId: openPeriod.id,
        amount: 50,
        paymentMethod: 'TRANSFER',
        paidAt: now,
        status: 'PENDING',
        createdAt: now,
      } as { id: string });

      const statuses = await statusesOf(
        times(() => send('POST', '/payment-reports/report_1/review', { action: 'approve' }))
      );

      expectSingleWinner(statuses);
      expect((await read('paymentReports', 'report_1'))?.status).toBe('APPROVED');
      expect(await count('domainEvents', 'type', 'payment_report.approved')).toBe(1);
    });

    it('un adelanto con el mismo ancla cobra un solo mes', async () => {
      await seed('subscriptions', subscription);
      await seed('billingPeriods', { ...openPeriod, status: 'PAID', paidAt: now, paymentMethod: 'CASH' });

      const statuses = await statusesOf(
        times(() =>
          send('POST', `/subscriptions/${subscription.id}/pay-advance`, {
            paymentMethod: 'CASH',
            paidAt: paidAtText,
            anchorPeriodId: openPeriod.id,
          })
        )
      );

      expectSingleWinner(statuses);
      expect(await count('billingPeriods')).toBe(2);
    });

    it('la deuda saldada reactiva y crea un solo período', async () => {
      const lastYear = now.getUTCFullYear() - 1;
      await seed('subscriptions', { ...subscription, status: 'SUSPENDED', suspensionSource: 'AUTOMATIC' } as Subscription);
      await seed('billingPeriods', {
        ...openPeriod,
        status: 'OVERDUE',
        startDate: new Date(Date.UTC(lastYear, 0, 1)),
        endDate: new Date(Date.UTC(lastYear, 1, 1)),
      });

      expectSingleWinner(await statusesOf(times(pay)));

      expect(await count('billingPeriods')).toBe(2);
      const saved = await read('subscriptions', subscription.id);
      expect(saved?.status).toBe('ACTIVE');
      expect(saved).not.toHaveProperty('suspensionSource');
    });

    it('un pago de plan no extiende el vencimiento dos veces', async () => {
      await seed('organizations', organization);
      const report = {
        id: 'plan_report_1',
        organizationId: ORG,
        plan: 'pro' as const,
        amount: 25,
        method: 'usdt' as const,
        paidAt: now,
        months: 1,
        status: 'PENDING' as const,
        createdAt: now,
        createdByUserId: 'user_1',
      };
      await seed('organizationPlanPaymentReports', report);
      const current = await organizationRepository.getById(ORG);
      const expiry = new Date(Date.UTC(now.getUTCFullYear() + 1, 1, 1));

      const results = await Promise.allSettled(
        times(() => {
          const id = `payment_${Math.random()}`;
          return organizationRepository.registerPlanPayment(
            {
              id,
              organizationId: ORG,
              paidAt: now,
              amount: 25,
              method: 'usdt',
              plan: 'pro',
              months: 1,
              newPlanExpiresAt: expiry,
              createdBy: 'user_1',
              createdAt: now,
            },
            'pro',
            75,
            expiry,
            1,
            { expected: current!, approvedReport: { ...report, status: 'APPROVED' } }
          );
        })
      );

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await count('organizationPlanPayments')).toBe(1);
      expect((await read('organizationPlanPaymentReports', report.id))?.status).toBe('APPROVED');
    });
  });

  describe('Daily Job de extremo a extremo', () => {
    // Un día de corte válido (1-28) ya terminado.
    let dueDate = new Date(today.getTime() - DAY_MS);
    while (dueDate.getUTCDate() > 28) dueDate = new Date(dueDate.getTime() - DAY_MS);
    const dueSubscription: Subscription = {
      ...subscription,
      billingDay: dueDate.getUTCDate(),
      currentPeriodId: 'period_due',
      currentPeriodStatus: 'PENDING',
      radarUpdatedAt: new Date('2026-01-01T10:20:30.123Z'),
    };
    const duePeriod: BillingPeriod = {
      ...openPeriod,
      id: 'period_due',
      startDate: new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth() - 1, dueDate.getUTCDate())),
      endDate: dueDate,
    };

    beforeEach(async () => {
      await seed('organizations', organization);
      await seed('clients', {
        id: subscription.clientId,
        organizationId: ORG,
        firstName: 'Ana',
        lastName: 'López',
        phone: '+584120000000',
        createdAt: now,
      } as { id: string });
      await seed('subscriptions', { ...dueSubscription, kitNumber: 'KIT-ORIGINAL' });
      await seed('billingPeriods', duePeriod);
    });

    it('vence, genera y es idempotente en una segunda ejecución', async () => {
      const first = await runDailyJobForOrganization(ORG);
      expect(first).toMatchObject({ overdue: 1, generated: 1, suspended: 0, skipped: false });

      expect((await read('billingPeriods', duePeriod.id))?.status).toBe('OVERDUE');
      expect(await count('billingPeriods')).toBe(2);
      const saved = await read('subscriptions', subscription.id);
      expect(saved?.kitNumber).toBe('KIT-ORIGINAL');
      expect(saved?.overduePeriods).toBe(1);
      expect(saved?.currentPeriodId).not.toBe(duePeriod.id);

      const second = await runDailyJobForOrganization(ORG);
      expect(second).toMatchObject({ overdue: 0, generated: 0, skipped: false });
      expect(await count('billingPeriods')).toBe(2);

      const logs = await db().collection('schedulerLogs').get();
      expect(logs.docs.map((doc) => doc.data().status)).toEqual(['success', 'success']);
    });

    it('la fecha guardada coincide con la leída al validar el estado esperado', async () => {
      const outcome = await subscriptionTransactions.applyDailyJobChange({
        subscriptionId: subscription.id,
        expected: {
          status: 'ACTIVE',
          currentPeriodId: 'period_due',
          radarUpdatedAt: dueSubscription.radarUpdatedAt,
        },
        overduePeriodIds: [duePeriod.id],
        createdPeriods: [],
        events: [],
      });

      expect(outcome).toBe('applied');
      expect((await read('billingPeriods', duePeriod.id))?.status).toBe('OVERDUE');
    });

    it('omite la suscripción si un pago llegó después de leerla', async () => {
      await pay();
      await seed('billingPeriods', { ...duePeriod, status: 'PAID' });

      const outcome = await subscriptionTransactions.applyDailyJobChange({
        subscriptionId: subscription.id,
        expected: {
          status: 'ACTIVE',
          currentPeriodId: 'period_due',
          radarUpdatedAt: dueSubscription.radarUpdatedAt,
        },
        overduePeriodIds: [duePeriod.id],
        createdPeriods: [],
        events: [],
      });

      expect(outcome).toBe('stale');
      expect((await read('billingPeriods', duePeriod.id))?.status).toBe('PAID');
    });

    it('un job y un pago simultáneos dejan el período pagado', async () => {
      await db().collection('billingPeriods').doc(duePeriod.id).delete();
      await seed('billingPeriods', { ...openPeriod, id: duePeriod.id, endDate: dueDate, startDate: duePeriod.startDate });

      const [payment] = await Promise.all([
        send('POST', `/billing-periods/${duePeriod.id}/pay`, {
          paymentMethod: 'CASH',
          amount: 50,
          paidAt: paidAtText,
        }),
        runDailyJobForOrganization(ORG),
      ]);

      expect(payment.status).toBe(200);
      expect((await read('billingPeriods', duePeriod.id))?.status).toBe('PAID');
    });
  });

  describe('borrados', () => {
    it('eliminar una suscripción borra sus períodos y reportes en una sola operación', async () => {
      await seed('subscriptions', subscription);
      await seed('billingPeriods', openPeriod);
      await seed('billingPeriods', { ...openPeriod, id: 'period_other', subscriptionId: 'sub_other' });
      await seed('paymentReports', {
        id: 'report_1',
        organizationId: ORG,
        subscriptionId: subscription.id,
        billingPeriodId: openPeriod.id,
        status: 'PENDING',
      } as { id: string });

      const response = await send('DELETE', `/subscriptions/${subscription.id}`, {});

      expect(response.status).toBe(204);
      expect(await read('subscriptions', subscription.id)).toBeUndefined();
      expect(await read('billingPeriods', openPeriod.id)).toBeUndefined();
      expect(await read('paymentReports', 'report_1')).toBeUndefined();
      expect(await read('billingPeriods', 'period_other')).toBeDefined();
      expect(await count('domainEvents', 'type', 'subscription.deleted')).toBe(1);
    });

    it('no elimina un cliente con una suscripción suspendida y su contador no cambia', async () => {
      await seed('organizations', organization);
      await seed('clients', { id: subscription.clientId, organizationId: ORG } as { id: string });
      await seed('subscriptions', { ...subscription, status: 'SUSPENDED' });

      await expect(
        clientRepository.deleteAndDecrementClientCount(subscription.clientId, ORG)
      ).rejects.toMatchObject({ code: 'CLIENT_HAS_SUBSCRIPTIONS' });

      expect(await read('clients', subscription.clientId)).toBeDefined();
      expect((await read('organizations', ORG))?.clientCount).toBe(1);
    });

    it('elimina un cliente sin suscripciones y descuenta el contador', async () => {
      await seed('organizations', organization);
      await seed('clients', { id: subscription.clientId, organizationId: ORG } as { id: string });

      await expect(
        clientRepository.deleteAndDecrementClientCount(subscription.clientId, ORG)
      ).resolves.toBe(true);

      expect(await read('clients', subscription.clientId)).toBeUndefined();
      expect((await read('organizations', ORG))?.clientCount).toBe(0);
    });
  });

  describe('reglas de seguridad', () => {
    const documentsUrl = () =>
      `http://${process.env.FIRESTORE_EMULATOR_HOST}/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
    // El emulador acepta tokens sin firmar: simula a un usuario real de Firebase Auth.
    const tokenFor = (claims: Record<string, unknown>) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const payload = {
        sub: 'user_1',
        user_id: 'user_1',
        aud: PROJECT_ID,
        iss: `https://securetoken.google.com/${PROJECT_ID}`,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
        ...claims,
      };
      return `${encode({ alg: 'none', type: 'JWT' })}.${encode(payload)}.`;
    };

    it.each([
      ['sin autenticar', undefined],
      ['admin de la organización', { role: 'admin', organizationId: ORG }],
      ['super-admin', { role: 'super-admin', organizationId: null }],
    ])('%s no puede leer ni escribir directamente', async (_name, claims) => {
      await seed('users', { id: 'user_1', role: 'admin', organizationId: ORG, password: 'hash' } as { id: string });
      await seed('subscriptions', subscription);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (claims) headers.Authorization = `Bearer ${tokenFor(claims)}`;

      const reads = await Promise.all(
        ['users/user_1', `subscriptions/${subscription.id}`].map((path) =>
          fetch(`${documentsUrl()}/${path}`, { headers })
        )
      );
      const write = await fetch(`${documentsUrl()}/users/user_1?updateMask.fieldPaths=role`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ fields: { role: { stringValue: 'super-admin' } } }),
      });

      expect(reads.map((response) => response.status)).toEqual([403, 403]);
      expect(write.status).toBe(403);
      expect((await read('users', 'user_1'))?.role).toBe('admin');
    });
  });

  describe('campos eliminados', () => {
    it('update elimina del documento un campo en undefined', async () => {
      const client = {
        id: 'client_dni',
        organizationId: ORG,
        firstName: 'Ana',
        lastName: 'López',
        phone: '+584120000000',
        dni: 'V-12345678',
        createdAt: now,
      };
      await seed('clients', client);

      await clientRepository.update({ ...client, dni: undefined });

      const saved = await read('clients', client.id);
      expect(saved).not.toHaveProperty('dni');
      expect(saved?.firstName).toBe('Ana');
    });
  });
});
