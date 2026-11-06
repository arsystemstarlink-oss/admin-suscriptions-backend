import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { BillingPeriod, Plan, Subscription } from '../domain/entities';
import {
  billingPeriodRepository,
  domainEventRepository,
  planRepository,
  subscriptionRepository,
} from '../infrastructure/repositories';
import subscriptionsRouter from '../api/routes/subscriptions';
import billingPeriodsRouter from '../api/routes/billing-periods';
import { errorHandler } from '../api/middleware/error-handler';

const batchSet = jest.fn();
const batchCommit = jest.fn(async () => undefined);

jest.mock('../infrastructure/repositories', () => ({
  billingPeriodRepository: { getByIdScoped: jest.fn(), listBySubscriptionId: jest.fn() },
  subscriptionRepository: { getByIdScoped: jest.fn(), update: jest.fn() },
  planRepository: { getByIdScoped: jest.fn() },
  clientRepository: { getByIdScoped: jest.fn() },
  domainEventRepository: { create: jest.fn() },
}));
jest.mock('../infrastructure/stats-service', () => ({ scheduleStatsRecompute: jest.fn() }));
jest.mock('../infrastructure/firebase', () => ({
  getFirestore: () => ({
    batch: () => ({ set: batchSet, commit: batchCommit }),
    collection: (name: string) => ({ doc: (id: string) => ({ path: `${name}/${id}` }) }),
  }),
}));

const periods = billingPeriodRepository as unknown as {
  getByIdScoped: jest.Mock;
  listBySubscriptionId: jest.Mock;
};
const subscriptions = subscriptionRepository as unknown as {
  getByIdScoped: jest.Mock;
  update: jest.Mock;
};
const plans = planRepository as unknown as { getByIdScoped: jest.Mock };
const events = domainEventRepository as unknown as { create: jest.Mock };

const ORG = 'org_1';
const today = new Date();
const startOfCycle = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
const endOfCycle = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

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
  status: 'SUSPENDED',
  maxOverduePeriods: 2,
  createdAt: new Date(0),
};
const openPeriod: BillingPeriod = {
  id: 'period_1',
  organizationId: ORG,
  subscriptionId: subscription.id,
  periodLabel: 'Ciclo',
  startDate: startOfCycle,
  endDate: endOfCycle,
  amount: 50,
  status: 'PENDING',
  createdAt: new Date(0),
};

function writtenTo(collection: string): any[] {
  return batchSet.mock.calls
    .filter(([ref]) => ref.path.startsWith(`${collection}/`))
    .map(([, data]) => data);
}

describe('reactivación de suscripciones (rutas)', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { auth: unknown }).auth = {
        userId: 'user_1',
        role: 'admin',
        organizationId: ORG,
      };
      next();
    });
    app.use('/subscriptions', subscriptionsRouter);
    app.use('/billing-periods', billingPeriodsRouter);
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
    plans.getByIdScoped.mockResolvedValue(plan);
    events.create.mockResolvedValue(undefined);
  });

  const pay = () =>
    fetch(`${baseUrl}/billing-periods/${openPeriod.id}/pay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentMethod: 'CASH',
        amount: 50,
        paidAt: today.toISOString().slice(0, 10),
      }),
    });

  const put = (body: unknown) =>
    fetch(`${baseUrl}/subscriptions/${subscription.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('pagar con suspensión MANUAL no reactiva ni crea un período duplicado', async () => {
    periods.getByIdScoped.mockResolvedValue(openPeriod);
    periods.listBySubscriptionId.mockResolvedValue([openPeriod]);
    subscriptions.getByIdScoped.mockResolvedValue({ ...subscription, suspensionSource: 'MANUAL' });

    const response = await pay();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.subscription).toMatchObject({ status: 'SUSPENDED', reactivated: false });
    expect(writtenTo('billingPeriods')).toHaveLength(1);
    expect(writtenTo('subscriptions')[0].suspensionSource).toBe('MANUAL');
  });

  it('pagar una suspensión sin origen reactiva sin duplicar el ciclo ya cubierto', async () => {
    periods.getByIdScoped.mockResolvedValue(openPeriod);
    periods.listBySubscriptionId.mockResolvedValue([openPeriod]);
    subscriptions.getByIdScoped.mockResolvedValue(subscription);

    const response = await pay();
    const body = await response.json();

    expect(body.subscription).toMatchObject({ status: 'ACTIVE', reactivated: true });
    expect(body.currentPeriod).toBeUndefined();
    expect(writtenTo('billingPeriods')).toHaveLength(1);
    expect(writtenTo('billingPeriods')[0].status).toBe('PAID');
  });

  it('suspender a mano guarda el origen MANUAL', async () => {
    subscriptions.getByIdScoped.mockResolvedValue({ ...subscription, status: 'ACTIVE' });
    periods.listBySubscriptionId.mockResolvedValue([openPeriod]);

    const response = await put({ status: 'SUSPENDED' });

    expect(response.status).toBe(200);
    expect(subscriptions.update.mock.calls[0][0]).toMatchObject({
      status: 'SUSPENDED',
      suspensionSource: 'MANUAL',
    });
  });

  it('reenviar SUSPENDED conserva el origen de una suspensión por deuda', async () => {
    subscriptions.getByIdScoped.mockResolvedValue({ ...subscription, suspensionSource: 'AUTOMATIC' });
    periods.listBySubscriptionId.mockResolvedValue([openPeriod]);

    await put({ status: 'SUSPENDED' });

    expect(subscriptions.update.mock.calls[0][0].suspensionSource).toBe('AUTOMATIC');
  });

  it('reactivar a mano limpia el origen y crea el ciclo de hoy, sin deuda de los meses suspendida', async () => {
    const oldPaid: BillingPeriod = {
      ...openPeriod,
      status: 'PAID',
      startDate: new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)),
      endDate: new Date(Date.UTC(today.getUTCFullYear() - 1, 1, 1)),
    };
    subscriptions.getByIdScoped.mockResolvedValue({ ...subscription, suspensionSource: 'MANUAL' });
    periods.listBySubscriptionId.mockResolvedValue([oldPaid]);

    const response = await put({ status: 'ACTIVE' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(subscriptions.update).not.toHaveBeenCalled();
    const [created] = writtenTo('billingPeriods');
    expect(new Date(created.startDate).getTime()).toBeLessThanOrEqual(today.getTime());
    expect(new Date(created.endDate).getTime()).toBeGreaterThan(today.getTime());
    expect(created.status).toBe('PENDING');
    expect(writtenTo('subscriptions')[0]).not.toHaveProperty('suspensionSource');
    expect(body.currentPeriodId).toBe(created.id);
    expect(events.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'billing_period.generated', entityId: created.id })
    );
  });

  it('reactivar a mano no duplica un ciclo que ya existe', async () => {
    subscriptions.getByIdScoped.mockResolvedValue({ ...subscription, suspensionSource: 'MANUAL' });
    periods.listBySubscriptionId.mockResolvedValue([openPeriod]);

    await put({ status: 'ACTIVE' });

    expect(batchCommit).not.toHaveBeenCalled();
    expect(subscriptions.update.mock.calls[0][0]).toMatchObject({
      status: 'ACTIVE',
      suspensionSource: undefined,
    });
  });
});
