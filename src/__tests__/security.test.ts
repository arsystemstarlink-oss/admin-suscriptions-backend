import express, { Request } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createFakeFirestore } from './support/fake-firestore';
import authRouter from '../api/routes/auth';
import adminsRouter from '../api/routes/admins';
import organizationsRouter from '../api/routes/organizations';
import schedulerRouter from '../api/routes/scheduler';
import { errorHandler } from '../api/middleware/error-handler';
import { authService } from '../domain/auth-service';
import { User } from '../domain/entities';

const updateFirebaseUser = jest.fn(async () => undefined);

jest.mock('../infrastructure/firebase', () => {
  const { createFakeFirestore: create } = jest.requireActual('./support/fake-firestore');
  const fake = create();
  return {
    __fake: fake,
    getFirestore: () => fake.db,
    admin: { ...fake.admin, auth: () => ({ updateUser: (...args: unknown[]) => updateFirebaseUser(...(args as [])) }) },
    syncUserCustomClaims: jest.fn(async () => undefined),
  };
});
jest.mock('../infrastructure/stats-service', () => ({
  scheduleStatsRecompute: jest.fn(),
  deleteOrganizationStats: jest.fn(async () => undefined),
}));
jest.mock('../infrastructure/scheduler', () => ({
  scheduleOrganization: jest.fn(async () => true),
  runDailyJobForOrganization: jest.fn(),
  syncOrganizationSchedule: jest.fn(async () => undefined),
  unscheduleOrganization: jest.fn(),
}));

const fake: ReturnType<typeof createFakeFirestore> = jest.requireMock('../infrastructure/firebase').__fake;

const ORG = 'org_1';
const PASSWORD = 'Clave1234';
const now = new Date();

const organization = {
  id: ORG,
  name: 'ORG',
  slug: 'org',
  active: true,
  plan: 'pro',
  clientLimit: 75,
  planStatus: 'activo',
  trialEndsAt: null,
  planExpiresAt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1)),
  clientCount: 1,
  createdAt: new Date(0),
};
const baseUser = (id: string, email: string, password: string): User => ({
  id,
  name: id,
  email,
  password,
  role: 'admin',
  organizationId: ORG,
  createdAt: new Date(0),
});

describe('seguridad', () => {
  let server: Server;
  let baseUrl: string;
  let passwordHash: string;

  beforeAll(async () => {
    process.env.JWT_SECRET = 'x'.repeat(40);
    process.env.JWT_REFRESH_SECRET = 'y'.repeat(40);
    passwordHash = await authService.hashPassword(PASSWORD);
    const app = express();
    app.use(express.json());
    app.use('/auth', authRouter);
    app.use((req, _res, next) => {
      const role = req.headers['x-role'] === 'super-admin' ? 'super-admin' : 'admin';
      (req as Request & { auth: unknown }).auth = {
        userId: 'user_a',
        role,
        organizationId: role === 'admin' ? ORG : null,
      };
      next();
    });
    app.use('/admins', adminsRouter);
    app.use('/organizations', organizationsRouter);
    app.use('/scheduler', schedulerRouter);
    app.use(errorHandler);
    await new Promise<void>((resolve) => {
      server = app.listen(0, resolve);
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll((done) => {
    server.close(done);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    fake.clear();
    fake.seed('organizations', organization);
    fake.seed('users', baseUser('user_a', 'a@example.com', passwordHash));
    fake.seed('users', baseUser('user_b', 'b@example.com', passwordHash));
  });

  const send = async (method: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  describe('credenciales propias en /admins', () => {
    it.each([
      ['el email', { email: 'nuevo@example.com' }],
      ['la contraseña', { newPassword: 'NuevaClave1' }],
    ])('no permite cambiar %s propio sin la contraseña actual', async (_name, body) => {
      const response = await send('PUT', '/admins/user_a', body);

      expect(response.status).toBe(403);
      expect(fake.read('users', 'user_a')).toMatchObject({ email: 'a@example.com', password: passwordHash });
    });

    it('permite editar el nombre propio reenviando el mismo email', async () => {
      const response = await send('PUT', '/admins/user_a', { name: 'Nombre nuevo', email: 'a@example.com' });

      expect(response.status).toBe(200);
      expect(fake.read('users', 'user_a')?.name).toBe('Nombre nuevo');
    });

    it('permite cambiar el email de otro admin de la organización', async () => {
      const response = await send('PUT', '/admins/user_b', { email: 'nuevo@example.com' });

      expect(response.status).toBe(200);
      expect(fake.read('users', 'user_b')?.email).toBe('nuevo@example.com');
    });
  });

  describe('PUT /auth/me', () => {
    const asUserA = () => {
      const token = authService.generateAccessToken(baseUser('user_a', 'a@example.com', passwordHash));
      return { Authorization: `Bearer ${token}` };
    };

    it('exige la contraseña actual para cambiar el email', async () => {
      const response = await send('PUT', '/auth/me', { email: 'nuevo@example.com' }, asUserA());

      expect(response.status).toBe(400);
      expect(fake.read('users', 'user_a')?.email).toBe('a@example.com');
      expect(updateFirebaseUser).not.toHaveBeenCalled();
    });

    it('al cambiar el email actualiza Firebase, revoca las sesiones y entrega tokens nuevos', async () => {
      fake.seed('refreshTokenSessions', { id: 'session_old', userId: 'user_a' });

      const response = await send(
        'PUT',
        '/auth/me',
        { email: 'nuevo@example.com', currentPassword: PASSWORD },
        asUserA()
      );

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toEqual(expect.any(String));
      expect(response.body.refreshToken).toEqual(expect.any(String));
      expect(updateFirebaseUser).toHaveBeenCalledWith('user_a', { email: 'nuevo@example.com' });
      expect(fake.read('refreshTokenSessions', 'session_old')?.revokedAt).toBeDefined();
      expect(fake.all('refreshTokenSessions').filter((session) => !session.revokedAt)).toHaveLength(1);
    });

    it('si el email no cambia no revoca sesiones', async () => {
      fake.seed('refreshTokenSessions', { id: 'session_old', userId: 'user_a' });

      const response = await send('PUT', '/auth/me', { name: 'Otro nombre' }, asUserA());

      expect(response.status).toBe(200);
      expect(response.body.accessToken).toBeUndefined();
      expect(fake.read('refreshTokenSessions', 'session_old')?.revokedAt).toBeUndefined();
    });
  });

  describe('pago de plan', () => {
    const superAdmin = { 'x-role': 'super-admin' };
    const payment = { paidAt: now.toISOString().slice(0, 10), method: 'usdt', plan: 'pro' };

    it('no acepta un vencimiento manual sin meses, que cobraría un solo mes', async () => {
      const farExpiry = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1)).toISOString();

      const response = await send(
        'POST',
        `/organizations/${ORG}/plan-payments`,
        { ...payment, newPlanExpiresAt: farExpiry },
        superAdmin
      );

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_PLAN_MONTHS');
      expect(fake.all('organizationPlanPayments')).toHaveLength(0);
    });

    it('cobra según los meses indicados', async () => {
      const response = await send(
        'POST',
        `/organizations/${ORG}/plan-payments`,
        { ...payment, months: 3 },
        superAdmin
      );

      expect(response.status).toBe(201);
      expect(response.body.payment).toMatchObject({ amount: 75, months: 3 });
    });
  });

  describe('configuración del cron', () => {
    it.each(['0 0 59 59 *', '* * * * *', '*/5 * * * *', '0 */2 * * *', '60 0 * * *', '0 24 * * *', 'hola'])(
      'rechaza "%s" sin guardarlo',
      async (cronSchedule) => {
        const response = await send('PUT', '/scheduler/config', { cronSchedule });

        expect(response.status).toBe(400);
        expect(response.body.error.code).toBe('INVALID_CRON');
        expect(fake.read('schedulerConfig', ORG)).toBeUndefined();
      }
    );

    it.each(['0 0 * * *', '30 2 * * *', '59 23 * * *'])('acepta "%s"', async (cronSchedule) => {
      const response = await send('PUT', '/scheduler/config', { cronSchedule });

      expect(response.status).toBe(200);
      expect(fake.read('schedulerConfig', ORG)?.cronSchedule).toBe(cronSchedule);
    });
  });
});
