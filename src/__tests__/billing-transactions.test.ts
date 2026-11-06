import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createFakeFirestore } from './support/fake-firestore';
import subscriptionsRouter from '../api/routes/subscriptions';
import billingPeriodsRouter from '../api/routes/billing-periods';
import paymentReportsRouter from '../api/routes/payment-reports';
import { errorHandler } from '../api/middleware/error-handler';
import { subscriptionTransactions } from '../infrastructure/billing-transactions';
import {
  organizationPlanPaymentReportRepository,
  organizationRepository,
} from '../infrastructure/repositories';
import { buildBillingPeriodId } from '../domain/business-rules';
import { BillingPeriod, Organization, OrganizationPlanPayment, OrganizationPlanPaymentReport, Plan, Subscription } from '../domain/entities';

jest.mock('../infrastructure/firebase', () => {
  const { createFakeFirestore: create } = jest.requireActual('./support/fake-firestore');
  const fake = create();
  return { __fake: fake, getFirestore: () => fake.db, admin: fake.admin };
});
jest.mock('../infrastructure/stats-service', () => ({ scheduleStatsRecompute: jest.fn() }));
jest.mock('../infrastructure/badge-cache', () => ({ invalidateBadges: jest.fn() }));

const fake: ReturnType<typeof createFakeFirestore> = jest.requireMock('../infrastructure/firebase').__fake;

const ORG = 'org_1';
const today = new Date();
const paidAtText = today.toISOString().slice(0, 10);
const cycleStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
const cycleEnd = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1));

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

const events = (type: string) => fake.all('domainEvents').filter((event) => event.type === type);

describe('transacciones de facturación', () => {
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

  beforeEach(() => {
    fake.clear();
    fake.seed('plans', plan);
  });

  const send = (method: string, path: string, body: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const pay = (periodId = openPeriod.id) =>
    send('POST', `/billing-periods/${periodId}/pay`, { paymentMethod: 'CASH', amount: 50, paidAt: paidAtText });

  describe('pago de período', () => {
    it('dos pagos simultáneos del mismo período: uno se aplica y el otro recibe 409', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', openPeriod);

      fake.overlapNextTransactions(2);
      const statuses = (await Promise.all([pay(), pay()])).map((response) => response.status).sort();

      expect(statuses).toEqual([200, 409]);
      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('PAID');
      expect(events('billing_period.paid')).toHaveLength(1);
    });

    it('al reactivar por deuda saldada crea un solo período aunque lleguen dos pagos', async () => {
      const overdue: BillingPeriod = {
        ...openPeriod,
        startDate: new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)),
        endDate: new Date(Date.UTC(today.getUTCFullYear() - 1, 1, 1)),
        status: 'OVERDUE',
      };
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED', suspensionSource: 'AUTOMATIC' });
      fake.seed('billingPeriods', overdue);

      fake.overlapNextTransactions(2);
      await Promise.all([pay(), pay()]);

      const periods = fake.all('billingPeriods');
      expect(periods).toHaveLength(2);
      expect(periods.filter((period) => period.status === 'PENDING')).toHaveLength(1);
      const saved = fake.read('subscriptions', subscription.id);
      expect(saved?.status).toBe('ACTIVE');
      expect(saved).not.toHaveProperty('suspensionSource');
    });

    it('con suspensión MANUAL no reactiva ni duplica el período', async () => {
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED', suspensionSource: 'MANUAL' });
      fake.seed('billingPeriods', openPeriod);

      const response = await pay();
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.subscription).toMatchObject({ status: 'SUSPENDED', reactivated: false });
      expect(fake.all('billingPeriods')).toHaveLength(1);
      expect(fake.read('subscriptions', subscription.id)?.suspensionSource).toBe('MANUAL');
    });

    it('con suspensión sin origen reactiva sin duplicar el ciclo ya cubierto', async () => {
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED' });
      fake.seed('billingPeriods', openPeriod);

      const response = await pay();
      const body = await response.json();

      expect(body.subscription).toMatchObject({ status: 'ACTIVE', reactivated: true });
      expect(body.currentPeriod).toBeUndefined();
      expect(fake.all('billingPeriods')).toHaveLength(1);
    });

    it('no paga un período de otra organización', async () => {
      fake.seed('subscriptions', { ...subscription, organizationId: 'org_2' });
      fake.seed('billingPeriods', { ...openPeriod, organizationId: 'org_2' });

      const response = await pay();

      expect(response.status).toBe(404);
      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('PENDING');
    });
  });

  describe('reportes de pago', () => {
    const report = {
      id: 'report_1',
      organizationId: ORG,
      clientId: subscription.clientId,
      subscriptionId: subscription.id,
      billingPeriodId: openPeriod.id,
      amount: 50,
      paymentMethod: 'TRANSFER',
      paidAt: today,
      status: 'PENDING',
      createdAt: today,
    };
    const review = (body: unknown) => send('POST', `/payment-reports/${report.id}/review`, body);

    beforeEach(() => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', openPeriod);
      fake.seed('paymentReports', report);
    });

    it('dos aprobaciones simultáneas aplican el pago una sola vez', async () => {
      fake.overlapNextTransactions(2);
      const statuses = (await Promise.all([review({ action: 'approve' }), review({ action: 'approve' })]))
        .map((response) => response.status)
        .sort();

      expect(statuses).toEqual([200, 409]);
      expect(fake.read('paymentReports', report.id)?.status).toBe('APPROVED');
      expect(events('billing_period.paid')).toHaveLength(1);
      expect(events('payment_report.approved')).toHaveLength(1);
      expect(fake.commits).toBe(1);
    });

    it('aprobar guarda la referencia del cliente; un cobro directo no crea ninguna', async () => {
      fake.seed('paymentReports', { ...report, notes: 'Banco 123' });

      await review({ action: 'approve' });

      expect(fake.read('billingPeriods', openPeriod.id)).toMatchObject({
        notes: 'Banco 123',
        paymentReference: 'Banco 123',
      });

      fake.seed('billingPeriods', { ...openPeriod, status: 'PENDING', notes: undefined, paymentReference: undefined });
      await send('POST', `/billing-periods/${openPeriod.id}/pay`, {
        paymentMethod: 'CASH',
        amount: 50,
        paidAt: paidAtText,
        notes: 'Nota interna',
      });

      const directPayment = fake.read('billingPeriods', openPeriod.id);
      expect(directPayment?.notes).toBe('Nota interna');
      expect(directPayment?.paymentReference).toBeUndefined();
    });

    it('aprobar y rechazar a la vez deja un único resultado coherente', async () => {
      fake.overlapNextTransactions(2);
      const responses = await Promise.all([
        review({ action: 'approve' }),
        review({ action: 'reject', notes: 'Comprobante ilegible' }),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const finalStatus = fake.read('paymentReports', report.id)?.status;
      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe(finalStatus === 'APPROVED' ? 'PAID' : 'PENDING');
    });

    it('si el período se cobró directamente, el reporte queda cerrado y no se puede aprobar', async () => {
      await pay();

      const response = await review({ action: 'approve' });

      expect(response.status).toBe(409);
      expect(await response.text()).toContain('PAYMENT_REPORT_ALREADY_REVIEWED');
      expect(fake.read('paymentReports', report.id)?.status).toBe('REJECTED');
      expect(events('billing_period.paid')).toHaveLength(1);
    });
  });

  describe('pago adelantado', () => {
    const paid: BillingPeriod = { ...openPeriod, status: 'PAID', paidAt: today, paymentMethod: 'CASH' };
    const advance = (body: Record<string, unknown> = {}) =>
      send('POST', `/subscriptions/${subscription.id}/pay-advance`, {
        paymentMethod: 'CASH',
        paidAt: paidAtText,
        ...body,
      });

    beforeEach(() => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', paid);
    });

    it('un doble envío con el mismo ancla cobra un solo mes', async () => {
      const body = { anchorPeriodId: paid.id };

      fake.overlapNextTransactions(2);
      const statuses = (await Promise.all([advance(body), advance(body)])).map((response) => response.status).sort();

      expect(statuses).toEqual([200, 409]);
      expect(fake.all('billingPeriods')).toHaveLength(2);
      expect(fake.read('subscriptions', subscription.id)?.totalPeriods).toBe(2);
    });

    it('sin ancla, dos adelantos simultáneos encadenan meses sin solaparse', async () => {
      fake.overlapNextTransactions(2);
      await Promise.all([advance(), advance()]);

      const periods = fake.all('billingPeriods').sort((a, b) => a.startDate.getTime() - b.startDate.getTime());
      expect(periods).toHaveLength(3);
      expect(periods[1].startDate).toEqual(periods[0].endDate);
      expect(periods[2].startDate).toEqual(periods[1].endDate);
    });

    it('permite prepagar otro mes indicando el nuevo ancla', async () => {
      const first = await (await advance({ anchorPeriodId: paid.id })).json();

      const second = await advance({ anchorPeriodId: first.billingPeriod.id });

      expect(second.status).toBe(200);
      expect(fake.all('billingPeriods')).toHaveLength(3);
    });
  });

  describe('edición de suscripción', () => {
    const put = (body: unknown) => send('PUT', `/subscriptions/${subscription.id}`, body);

    it('suspender a mano guarda el origen MANUAL', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', openPeriod);

      const response = await put({ status: 'SUSPENDED' });

      expect(response.status).toBe(200);
      expect(fake.read('subscriptions', subscription.id)).toMatchObject({
        status: 'SUSPENDED',
        suspensionSource: 'MANUAL',
      });
    });

    it('reenviar SUSPENDED conserva el origen de una suspensión por deuda', async () => {
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED', suspensionSource: 'AUTOMATIC' });
      fake.seed('billingPeriods', openPeriod);

      await put({ status: 'SUSPENDED' });

      expect(fake.read('subscriptions', subscription.id)?.suspensionSource).toBe('AUTOMATIC');
    });

    it('reactivar a mano limpia el origen y crea el ciclo de hoy sin deuda de los meses suspendida', async () => {
      const oldPaid: BillingPeriod = {
        ...openPeriod,
        status: 'PAID',
        startDate: new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)),
        endDate: new Date(Date.UTC(today.getUTCFullYear() - 1, 1, 1)),
      };
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED', suspensionSource: 'MANUAL' });
      fake.seed('billingPeriods', oldPaid);

      const response = await put({ status: 'ACTIVE' });
      const body = await response.json();

      expect(response.status).toBe(200);
      const created = fake.read('billingPeriods', buildBillingPeriodId(subscription.id, cycleStart));
      expect(created?.status).toBe('PENDING');
      expect(body.currentPeriodId).toBe(created?.id);
      expect(fake.read('subscriptions', subscription.id)).not.toHaveProperty('suspensionSource');
      expect(events('billing_period.generated')).toHaveLength(1);
    });

    it('reactivar a mano no duplica un ciclo que ya existe', async () => {
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED', suspensionSource: 'MANUAL' });
      fake.seed('billingPeriods', openPeriod);

      await put({ status: 'ACTIVE' });

      expect(fake.all('billingPeriods')).toHaveLength(1);
      expect(fake.read('subscriptions', subscription.id)?.status).toBe('ACTIVE');
    });

    it('una validación fallida no escribe nada', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', openPeriod);
      const before = fake.commits;

      const response = await put({ billingDay: 99 });

      expect(response.status).toBe(400);
      expect(fake.commits).toBe(before);
      expect(fake.read('subscriptions', subscription.id)?.billingDay).toBe(subscription.billingDay);
    });
  });

  describe('guardado del Daily Job', () => {
    const nextPeriod: BillingPeriod = {
      ...openPeriod,
      id: 'period_next',
      startDate: cycleEnd,
      endDate: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 1)),
    };
    const seen = { status: 'ACTIVE' as const, currentPeriodId: openPeriod.id, radarUpdatedAt: new Date(1000) };
    const stored: Subscription = { ...subscription, ...seen };
    const change = () => ({
      subscriptionId: subscription.id,
      expected: seen,
      subscription: { ...stored, status: 'SUSPENDED' as const, suspensionSource: 'AUTOMATIC' as const, currentPeriodId: nextPeriod.id },
      overduePeriodIds: [openPeriod.id],
      createdPeriods: [nextPeriod],
      events: [
        {
          id: 'event_1',
          type: 'billing_period.overdue' as const,
          organizationId: ORG,
          entity: 'billingPeriod',
          entityId: openPeriod.id,
          createdAt: new Date(),
        },
      ],
    });

    beforeEach(() => {
      fake.seed('subscriptions', stored);
      fake.seed('billingPeriods', openPeriod);
    });

    const expectNothingWritten = () => {
      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('PENDING');
      expect(fake.read('billingPeriods', nextPeriod.id)).toBeUndefined();
      expect(fake.all('domainEvents')).toHaveLength(0);
    };

    it('aplica todo junto y solo toca sus campos de la suscripción', async () => {
      fake.seed('subscriptions', { ...stored, kitNumber: 'EDITADO' });

      await expect(subscriptionTransactions.applyDailyJobChange(change())).resolves.toBe('applied');

      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('OVERDUE');
      expect(fake.read('billingPeriods', nextPeriod.id)?.status).toBe('PENDING');
      expect(fake.all('domainEvents')).toHaveLength(1);
      expect(fake.read('subscriptions', subscription.id)).toMatchObject({
        status: 'SUSPENDED',
        suspensionSource: 'AUTOMATIC',
        kitNumber: 'EDITADO',
      });
    });

    it('no pisa un pago registrado mientras corría el job', async () => {
      fake.seed('billingPeriods', { ...openPeriod, status: 'PAID' });

      await expect(subscriptionTransactions.applyDailyJobChange(change())).resolves.toBe('stale');

      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('PAID');
      expect(fake.read('billingPeriods', nextPeriod.id)).toBeUndefined();
    });

    it('omite la suscripción si cambió después de leerla', async () => {
      fake.seed('subscriptions', { ...stored, radarUpdatedAt: new Date(2000) });

      await expect(subscriptionTransactions.applyDailyJobChange(change())).resolves.toBe('stale');

      expectNothingWritten();
    });

    it('omite la suscripción si la eliminaron', async () => {
      fake.db.collection('subscriptions').doc(subscription.id).delete();

      await expect(subscriptionTransactions.applyDailyJobChange(change())).resolves.toBe('stale');

      expectNothingWritten();
    });

    it('no sobrescribe un período que ya existe', async () => {
      fake.seed('billingPeriods', { ...nextPeriod, status: 'PAID' });

      await expect(subscriptionTransactions.applyDailyJobChange(change())).resolves.toBe('stale');

      expect(fake.read('billingPeriods', nextPeriod.id)?.status).toBe('PAID');
      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('PENDING');
    });

    it('frente a un pago simultáneo, el período siempre termina pagado', async () => {
      fake.overlapNextTransactions(2);
      await Promise.all([pay(), subscriptionTransactions.applyDailyJobChange(change())]);

      expect(fake.read('billingPeriods', openPeriod.id)?.status).toBe('PAID');
    });
  });

  describe('pago de plan', () => {
    const organization: Organization = {
      id: ORG,
      name: 'Org',
      active: true,
      plan: 'pro',
      clientLimit: 75,
      planStatus: 'activo',
      trialEndsAt: null,
      planExpiresAt: new Date(Date.UTC(today.getUTCFullYear() + 1, 0, 1)),
      clientCount: 1,
      createdAt: new Date(0),
    };
    const report: OrganizationPlanPaymentReport = {
      id: 'plan_report_1',
      organizationId: ORG,
      plan: 'pro',
      amount: 25,
      method: 'usdt',
      paidAt: today,
      months: 1,
      status: 'PENDING',
      createdAt: today,
      createdByUserId: 'user_1',
    };
    const approved: OrganizationPlanPaymentReport = { ...report, status: 'APPROVED' };
    const payment = (id: string): OrganizationPlanPayment => ({
      id,
      organizationId: ORG,
      paidAt: today,
      amount: 25,
      method: 'usdt',
      plan: 'pro',
      months: 1,
      newPlanExpiresAt: new Date(Date.UTC(today.getUTCFullYear() + 1, 1, 1)),
      createdBy: 'user_1',
      createdAt: today,
    });
    const register = (id: string, expected: Organization = organization) =>
      organizationRepository.registerPlanPayment(
        payment(id),
        'pro',
        75,
        payment(id).newPlanExpiresAt,
        1,
        { expected, approvedReport: approved }
      );

    beforeEach(() => {
      fake.seed('organizations', organization);
      fake.seed('organizationPlanPaymentReports', report);
    });

    it('guarda el pago y el reporte aprobado juntos', async () => {
      await register('payment_1');

      expect(fake.read('organizationPlanPaymentReports', report.id)?.status).toBe('APPROVED');
      expect(fake.all('organizationPlanPayments')).toHaveLength(1);
    });

    it('dos aprobaciones simultáneas no extienden el plan dos veces', async () => {
      fake.overlapNextTransactions(2);
      const results = await Promise.allSettled([register('payment_1'), register('payment_2')]);

      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(fake.all('organizationPlanPayments')).toHaveLength(1);
    });

    it('rechaza el pago si el plan cambió desde que se calculó el vencimiento', async () => {
      const outdated = { ...organization, planExpiresAt: new Date(Date.UTC(today.getUTCFullYear(), 0, 1)) };

      await expect(register('payment_1', outdated)).rejects.toMatchObject({ code: 'PLAN_CONCURRENT_UPDATE' });

      expect(fake.all('organizationPlanPayments')).toHaveLength(0);
      expect(fake.read('organizationPlanPaymentReports', report.id)?.status).toBe('PENDING');
    });

    it('no rechaza un reporte que ya se revisó', async () => {
      fake.seed('organizationPlanPaymentReports', approved);

      await expect(
        organizationPlanPaymentReportRepository.reject({ ...report, status: 'REJECTED' })
      ).rejects.toMatchObject({ code: 'PLAN_PAYMENT_REPORT_ALREADY_REVIEWED' });

      expect(fake.read('organizationPlanPaymentReports', report.id)?.status).toBe('APPROVED');
    });
  });
});
