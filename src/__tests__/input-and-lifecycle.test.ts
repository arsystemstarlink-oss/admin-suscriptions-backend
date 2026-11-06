import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createFakeFirestore } from './support/fake-firestore';
import clientsRouter from '../api/routes/clients';
import plansRouter from '../api/routes/plans';
import subscriptionsRouter from '../api/routes/subscriptions';
import billingPeriodsRouter from '../api/routes/billing-periods';
import organizationsRouter from '../api/routes/organizations';
import authRouter from '../api/routes/auth';
import { requireWritablePlan } from '../api/middleware/organization-plan-access';
import { errorHandler } from '../api/middleware/error-handler';
import { authService } from '../domain/auth-service';
import { isValidDateString } from '../domain/business-rules';
import {
  syncOrganizationSchedule,
  unscheduleOrganization,
} from '../infrastructure/scheduler';

jest.mock('../infrastructure/firebase', () => {
  const { createFakeFirestore: create } = jest.requireActual('./support/fake-firestore');
  const fake = create();
  return {
    __fake: fake,
    getFirestore: () => fake.db,
    admin: { ...fake.admin, auth: () => ({ deleteUser: jest.fn(async () => undefined) }) },
    syncUserCustomClaims: jest.fn(async () => undefined),
  };
});
jest.mock('../infrastructure/stats-service', () => ({
  scheduleStatsRecompute: jest.fn(),
  deleteOrganizationStats: jest.fn(async () => undefined),
}));
jest.mock('../infrastructure/badge-cache', () => ({ invalidateBadges: jest.fn() }));
jest.mock('../infrastructure/scheduler', () => ({
  syncOrganizationSchedule: jest.fn(async () => undefined),
  unscheduleOrganization: jest.fn(),
}));

const fake: ReturnType<typeof createFakeFirestore> = jest.requireMock('../infrastructure/firebase').__fake;

const ORG = 'org_1';
const now = new Date();
const today = now.toISOString().slice(0, 10);
const tomorrow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

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
  clientCount: 1,
  createdAt: new Date(0),
};
const client = {
  id: 'client_1',
  organizationId: ORG,
  firstName: 'Ana',
  lastName: 'López',
  phone: '+584120000000',
  createdAt: new Date(0),
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

describe('validación de entrada y ciclo de vida', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use((req, _res, next) => {
      const role = req.headers['x-role'] === 'super-admin' ? 'super-admin' : 'admin';
      (req as Request & { auth: unknown }).auth = {
        userId: 'user_1',
        role,
        organizationId: role === 'admin' ? ORG : null,
      };
      next();
    });
    app.use('/organizations', organizationsRouter);
    app.use('/clients', requireWritablePlan, clientsRouter);
    app.use('/plans', requireWritablePlan, plansRouter);
    app.use('/subscriptions', requireWritablePlan, subscriptionsRouter);
    app.use('/billing-periods', requireWritablePlan, billingPeriodsRouter);
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
    fake.seed('clients', client);
    fake.seed('plans', {
      id: 'plan_1',
      organizationId: ORG,
      name: 'Plan',
      price: 50,
      description: 'Plan',
      active: true,
      createdAt: new Date(0),
    });
  });

  const send = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const errorCode = async (response: Response) => (await response.json()).error?.code;

  describe('validación de entrada', () => {
    it.each([
      ['POST', '/plans', { name: 'P', price: 'abc', description: 'D' }],
      ['POST', '/clients', { firstName: 123, lastName: 'L', phone: '04120000000' }],
      ['POST', '/clients', { firstName: 'F', lastName: 'L', phone: '04120000000', dni: 123 }],
      ['POST', '/subscriptions', { planId: 'plan_1', kitNumber: 'K', billingDay: 1, maxOverduePeriods: 1 }],
      ['POST', '/subscriptions', { clientId: 'client_1', planId: 'plan_1', kitNumber: 5, billingDay: 1, maxOverduePeriods: 1 }],
      ['PUT', '/subscriptions/sub_1', { status: 'CANCELLED' }],
      ['PUT', '/subscriptions/sub_1', { kitNumber: '   ' }],
      ['POST', '/billing-periods/period_1/pay', { paymentMethod: 'CASH', amount: '50', paidAt: today }],
    ])('%s %s rechaza un cuerpo inválido con 400 y no 500', async (method, path, body) => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', period);

      const response = await send(method, path, body);

      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe('INVALID_DATA');
    });

    it('un PUT de período no acepta un monto de texto', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', { ...period, status: 'PAID' });

      const response = await send('PUT', `/billing-periods/${period.id}`, { amount: 'abc' });

      expect(response.status).toBe(400);
      expect(fake.read('billingPeriods', period.id)?.amount).toBe(50);
    });

    it('acepta los valores que envía el formulario de clientes', async () => {
      const response = await send('POST', '/clients', {
        firstName: 'Ana',
        lastName: 'López',
        phone: '04121234567',
        dni: '',
        email: '',
        address: '',
      });

      expect(response.status).toBe(201);
    });

    it('permite borrar la cédula con null', async () => {
      fake.seed('clients', { ...client, dni: 'V-12345678' });

      const response = await send('PUT', `/clients/${client.id}`, { dni: null });

      expect(response.status).toBe(200);
      expect(fake.read('clients', client.id)).not.toHaveProperty('dni');
    });
  });

  describe('fechas', () => {
    it.each([
      ['2026-02-31', false],
      ['2026-13-01', false],
      ['2026-2-1', false],
      ['2024-02-29', true],
      ['2026-11-05', true],
    ])('isValidDateString(%s) es %s', (value, expected) => {
      expect(isValidDateString(value)).toBe(expected);
    });

    it('un pago con fecha inexistente se rechaza', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', period);

      const response = await send('POST', `/billing-periods/${period.id}/pay`, {
        paymentMethod: 'CASH',
        amount: 50,
        paidAt: '2026-02-31',
      });

      expect(await errorCode(response)).toBe('INVALID_DATE_FORMAT');
    });

    it('un pago con fecha futura se rechaza en /pay, en la edición y en el adelanto', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', period);
      fake.seed('billingPeriods', { ...period, id: 'period_paid', status: 'PAID' });

      const responses = await Promise.all([
        send('POST', `/billing-periods/${period.id}/pay`, { paymentMethod: 'CASH', amount: 50, paidAt: tomorrow }),
        send('PUT', '/billing-periods/period_paid', { paidAt: tomorrow }),
        send('POST', `/subscriptions/${subscription.id}/pay-advance`, { paymentMethod: 'CASH', paidAt: tomorrow }),
      ]);

      for (const response of responses) {
        expect(await errorCode(response)).toBe('INVALID_PAYMENT_DATE');
      }
      expect(fake.read('billingPeriods', period.id)?.status).toBe('PENDING');
    });
  });

  describe('borrados', () => {
    it('no elimina un cliente con una suscripción suspendida', async () => {
      fake.seed('subscriptions', { ...subscription, status: 'SUSPENDED' });

      const response = await send('DELETE', `/clients/${client.id}`);

      expect(response.status).toBe(409);
      expect(await errorCode(response)).toBe('CLIENT_HAS_SUBSCRIPTIONS');
      expect(fake.read('clients', client.id)).toBeDefined();
      expect(fake.read('organizations', ORG)?.clientCount).toBe(1);
    });

    it('no elimina un cliente con una suscripción activa', async () => {
      fake.seed('subscriptions', subscription);

      const response = await send('DELETE', `/clients/${client.id}`);

      expect(await errorCode(response)).toBe('CLIENT_HAS_ACTIVE_SUBSCRIPTIONS');
    });

    it('elimina un cliente sin suscripciones y descuenta el contador', async () => {
      const response = await send('DELETE', `/clients/${client.id}`);

      expect(response.status).toBe(204);
      expect(fake.read('clients', client.id)).toBeUndefined();
      expect(fake.read('organizations', ORG)?.clientCount).toBe(0);
    });

    it('eliminar una suscripción borra sus períodos y reportes, y lo registra', async () => {
      fake.seed('subscriptions', subscription);
      fake.seed('billingPeriods', period);
      fake.seed('paymentReports', {
        id: 'report_1',
        organizationId: ORG,
        subscriptionId: subscription.id,
        billingPeriodId: period.id,
        status: 'PENDING',
      });
      fake.seed('billingPeriods', { ...period, id: 'other', subscriptionId: 'sub_other' });

      const response = await send('DELETE', `/subscriptions/${subscription.id}`);

      expect(response.status).toBe(204);
      expect(fake.read('subscriptions', subscription.id)).toBeUndefined();
      expect(fake.read('billingPeriods', period.id)).toBeUndefined();
      expect(fake.read('paymentReports', 'report_1')).toBeUndefined();
      expect(fake.read('billingPeriods', 'other')).toBeDefined();
      expect(fake.all('domainEvents')[0]).toMatchObject({
        type: 'subscription.deleted',
        payload: { deletedPeriods: 1, deletedReports: 1 },
      });
    });

    it('no elimina una suscripción de otra organización', async () => {
      fake.seed('subscriptions', { ...subscription, organizationId: 'org_2' });

      const response = await send('DELETE', `/subscriptions/${subscription.id}`);

      expect(response.status).toBe(404);
      expect(fake.read('subscriptions', subscription.id)).toBeDefined();
    });

    it('eliminar una organización no deja datos suyos y conserva los de otras', async () => {
      const owned = { organizationId: ORG };
      fake.seed('users', { id: 'user_a', role: 'admin', ...owned });
      fake.seed('refreshTokenSessions', { id: 'session_a', userId: 'user_a' });
      const collections = [
        'subscriptions',
        'billingPeriods',
        'paymentReports',
        'whatsappMessages',
        'whatsappConversations',
        'pushSubscriptions',
        'domainEvents',
        'adminInvites',
        'organizationPlanPayments',
        'organizationPlanPaymentReports',
        'schedulerLogs',
      ];
      collections.forEach((name) => {
        fake.seed(name, { id: `${name}_mine`, ...owned });
        fake.seed(name, { id: `${name}_other`, organizationId: 'org_2' });
      });
      fake.seed('schedulerConfig', { id: ORG });
      fake.seed('jobLocks', { id: ORG });

      const response = await send('DELETE', `/organizations/${ORG}`, undefined, { 'x-role': 'super-admin' });

      expect(response.status).toBe(204);
      collections.forEach((name) => {
        expect([name, fake.all(name).map((doc) => doc.id)]).toEqual([name, [`${name}_other`]]);
      });
      ['organizations', 'users', 'clients', 'plans', 'refreshTokenSessions', 'schedulerConfig', 'jobLocks'].forEach((name) => {
        expect([name, fake.all(name)]).toEqual([name, []]);
      });
      expect(unscheduleOrganization).toHaveBeenCalledWith(ORG);
    });
  });

  describe('organización desactivada', () => {
    beforeEach(() => {
      fake.seed('organizations', { ...organization, active: false });
    });

    it('bloquea las escrituras', async () => {
      const response = await send('POST', '/plans', { name: 'P', price: 10, description: 'D' });

      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('ORGANIZATION_INACTIVE');
    });

    it('bloquea el inicio de sesión sin revelarlo a quien no tiene la contraseña', async () => {
      fake.seed('users', {
        id: 'user_a',
        name: 'Ana',
        email: 'ana@example.com',
        password: await authService.hashPassword('Clave1234'),
        role: 'admin',
        organizationId: ORG,
        createdAt: new Date(0),
      });

      const wrong = await send('POST', '/auth/login', { email: 'ana@example.com', password: 'Otra12345' });
      const right = await send('POST', '/auth/login', { email: 'ana@example.com', password: 'Clave1234' });

      expect(await errorCode(wrong)).toBe('INVALID_CREDENTIALS');
      expect(await errorCode(right)).toBe('ORGANIZATION_INACTIVE');
      expect(fake.all('refreshTokenSessions')).toHaveLength(0);
    });
  });

  describe('sincronización del cron', () => {
    it('crear una organización programa su cron', async () => {
      const response = await send('POST', '/organizations', { name: 'Nueva' }, { 'x-role': 'super-admin' });

      expect(response.status).toBe(201);
      expect(syncOrganizationSchedule).toHaveBeenCalledWith(expect.objectContaining({ name: 'NUEVA', active: true }));
    });

    it('desactivarla lo sincroniza y editar otro campo no', async () => {
      await send('PUT', `/organizations/${ORG}`, { name: 'Otro nombre' }, { 'x-role': 'super-admin' });
      expect(syncOrganizationSchedule).not.toHaveBeenCalled();

      await send('PUT', `/organizations/${ORG}`, { active: false }, { 'x-role': 'super-admin' });
      expect(syncOrganizationSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: ORG, active: false }));
    });
  });
});
