import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createFakeFirestore } from './support/fake-firestore';
import whatsappConfigRouter from '../api/routes/whatsapp-config';
import { errorHandler } from '../api/middleware/error-handler';
import { whatsappService } from '../infrastructure/whatsapp-service';
import { createInitialWhatsAppNotifications, getWhatsAppConfigurationReadiness } from '../infrastructure/whatsapp-configuration';
import { Organization } from '../domain/entities';

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
jest.mock('../api/middleware/auth', () => ({
  authenticateAdmin: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth: unknown }).auth = { userId: 'user_1', role: 'admin', organizationId: 'org_1' };
    next();
  },
}));

const fake: ReturnType<typeof createFakeFirestore> = jest.requireMock('../infrastructure/firebase').__fake;

const ACCOUNT_SID = `AC${'a'.repeat(32)}`;
const pendingRequest = {
  contentSid: 'HX_pending',
  name: 'payment_reminder_x',
  body: 'Hola {{1}}, vence el {{2}}.',
  status: 'pending',
  submittedAt: '2026-11-01T00:00:00.000Z',
};
const rules = { reminderDaysBefore: [3], dueDateWarningEnabled: true, suspensionNoticeEnabled: true };

function seedOrganization(overrides: Record<string, unknown> = {}): void {
  fake.seed('organizations', {
    id: 'org_1',
    name: 'ORG',
    slug: 'org',
    active: true,
    plan: 'pro',
    clientLimit: 75,
    planStatus: 'activo',
    trialEndsAt: null,
    planExpiresAt: new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1)),
    clientCount: 0,
    createdAt: new Date(0),
    twilio: { accountSid: ACCOUNT_SID, authToken: 'secret-token-1234567', phoneNumber: '+584111111111', enabled: true },
    whatsappNotifications: { rules, templates: {} },
    ...overrides,
  });
}

function twilioError(code: number): Error {
  return Object.assign(new Error(`Twilio ${code}`), { code, status: 400 });
}

describe('rutas de configuración de WhatsApp', () => {
  let server: Server;
  let baseUrl: string;
  const originalBaseUrl = process.env.BASE_URL;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use('/api/whatsapp', whatsappConfigRouter);
    app.use(errorHandler);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      done();
    });
  });

  afterAll((done) => {
    process.env.BASE_URL = originalBaseUrl;
    server.close(done);
  });

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    fake.clear();
    seedOrganization();
  });

  const send = (method: string, path: string, body?: unknown): Promise<globalThis.Response> =>
    fetch(`${baseUrl}/api/whatsapp${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const storedConfig = async (): Promise<any> => {
    const response = await send('GET', '/config');
    return response.json();
  };

  describe('PUT /config', () => {
    it('rechaza las credenciales que Twilio niega y no las guarda', async () => {
      jest.spyOn(whatsappService, 'verifyAccount').mockRejectedValue(twilioError(20003));

      const response = await send('PUT', '/config', { twilio: { authToken: 'otro-token-incorrecto-123' } });

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_TWILIO_CREDENTIALS');
      const stored = fake.read('organizations', 'org_1') as unknown as Organization;
      expect(stored.twilio?.authToken).toBe('secret-token-1234567');
    });

    it('guarda aunque Twilio esté caído: no es un rechazo de las credenciales', async () => {
      jest.spyOn(whatsappService, 'verifyAccount').mockRejectedValue(new Error('timeout'));

      const response = await send('PUT', '/config', { twilio: { authToken: 'token-nuevo-valido-123' } });

      expect(response.status).toBe(200);
      const stored = fake.read('organizations', 'org_1') as unknown as Organization;
      expect(stored.twilio?.authToken).toBe('token-nuevo-valido-123');
    });

    it('no consulta a Twilio si las credenciales no cambiaron', async () => {
      const verify = jest.spyOn(whatsappService, 'verifyAccount');

      const response = await send('PUT', '/config', { twilio: { phoneNumber: '+584111111112' } });

      expect(response.status).toBe(200);
      expect(verify).not.toHaveBeenCalled();
    });

    it('guardar las reglas conserva las plantillas en revisión', async () => {
      fake.clear();
      seedOrganization({
        whatsappNotifications: { rules, templates: {}, templateRequests: { reminder: pendingRequest } },
      });

      const response = await send('PUT', '/config', {
        rules: { reminderDaysBefore: [5] },
        templates: { reminder: null, dueDateWarning: null, suspensionNotice: null },
      });

      expect(response.status).toBe(200);
      const stored = fake.read('organizations', 'org_1') as unknown as Organization;
      expect(stored.whatsappNotifications?.rules.reminderDaysBefore).toEqual([5]);
      expect(stored.whatsappNotifications?.templateRequests?.reminder?.contentSid).toBe('HX_pending');
    });

    it('un SID puesto a mano anula la solicitud de esa plantilla', async () => {
      fake.clear();
      seedOrganization({
        whatsappNotifications: {
          rules,
          templates: {},
          templateRequests: { reminder: pendingRequest, suspensionNotice: { ...pendingRequest, contentSid: 'HX_s' } },
        },
      });

      await send('PUT', '/config', { templates: { reminder: 'HX_manual' } });

      const stored = fake.read('organizations', 'org_1') as unknown as Organization;
      expect(stored.whatsappNotifications?.templates.reminder).toBe('HX_manual');
      expect(stored.whatsappNotifications?.templateRequests?.reminder).toBeUndefined();
      expect(stored.whatsappNotifications?.templateRequests?.suspensionNotice?.contentSid).toBe('HX_s');
    });
  });

  it('GET /config nunca devuelve el Auth Token y expone las URLs públicas', async () => {
    process.env.BASE_URL = 'https://api.example.com';

    const body = await storedConfig();

    expect(JSON.stringify(body)).not.toContain('secret-token-1234567');
    expect(body.twilio.authTokenConfigured).toBe(true);
    expect(body.webhooks.inbound).toBe('https://api.example.com/communications/webhook');
  });

  it('un admin que pide otra organización sigue operando solo sobre la suya', async () => {
    fake.seed('organizations', {
      id: 'org_2',
      name: 'OTRA',
      active: true,
      createdAt: new Date(0),
      twilio: { accountSid: `AC${'b'.repeat(32)}`, authToken: 'token-de-otra-organizacion', phoneNumber: '+584222222222', enabled: true },
      whatsappNotifications: { rules, templates: {} },
    });
    const create = jest.spyOn(whatsappService, 'createTextTemplate').mockResolvedValue('HX_new');
    jest.spyOn(whatsappService, 'submitTemplateForApproval').mockResolvedValue();

    const response = await send('POST', '/config/templates/reminder/submit?organizationId=org_2', {});

    expect(response.status).toBe(201);
    expect(create.mock.calls[0][0].accountSid).toBe(ACCOUNT_SID);
    const other = fake.read('organizations', 'org_2') as unknown as Organization;
    expect(other.whatsappNotifications?.templateRequests).toBeUndefined();
  });

  describe('plantillas', () => {
    it('solicita la aprobación y la activa cuando Twilio la aprueba', async () => {
      jest.spyOn(whatsappService, 'createTextTemplate').mockResolvedValue('HX_new');
      jest.spyOn(whatsappService, 'submitTemplateForApproval').mockResolvedValue();
      const approval = jest
        .spyOn(whatsappService, 'fetchTemplateApproval')
        .mockResolvedValue({ status: 'received' });

      const submitted = await send('POST', '/config/templates/reminder/submit', {
        body: 'Hola {{1}}, tu pago vence el {{2}}. Gracias.',
      });
      expect(submitted.status).toBe(201);
      const reminder = (await submitted.json()).templates.find((t: { key: string }) => t.key === 'reminder');
      expect(reminder).toMatchObject({ activeContentSid: null, request: { status: 'pending' } });

      let listed = await (await send('GET', '/config/templates')).json();
      expect(listed.templates[0].activeContentSid).toBeNull();

      approval.mockResolvedValue({ status: 'approved' });
      listed = await (await send('GET', '/config/templates')).json();
      expect(listed.templates[0]).toMatchObject({ activeContentSid: 'HX_new', request: { status: 'approved' } });
      expect((await storedConfig()).templates.reminder).toBe('HX_new');
    });

    it.each([
      ['/config/templates/otra/submit', {}, 'INVALID_DATA'],
      ['/config/templates/reminder/submit', { body: 'Sin variables.' }, 'INVALID_WHATSAPP_TEMPLATE'],
    ])('rechaza %s', async (path, body, code) => {
      const create = jest.spyOn(whatsappService, 'createTextTemplate');

      const response = await send('POST', path, body);

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(code);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('POST /config/test-message', () => {
    const withTemplate = () => {
      fake.clear();
      seedOrganization({ whatsappNotifications: { rules, templates: { dueDateWarning: 'HX_due' } } });
    };

    it('exige una plantilla activa', async () => {
      const response = await send('POST', '/config/test-message', { to: '+584120000000' });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('WHATSAPP_TEMPLATE_REQUIRED');
    });

    it('rechaza un número inválido', async () => {
      const response = await send('POST', '/config/test-message', { to: '123' });

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_PHONE');
    });

    it('envía con datos de ejemplo y guarda el mensaje para recibir su estado', async () => {
      withTemplate();
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate').mockResolvedValue('SM_test');

      const response = await send('POST', '/config/test-message', { to: '+584120000000' });

      expect(response.status).toBe(201);
      expect(sendTemplate).toHaveBeenCalledWith(
        {
          to: '+584120000000',
          templateName: 'HX_due',
          variables: { '1': 'María Pérez', '2': 'KIT28J720NS8', '3': '2026-12-15' },
        },
        expect.objectContaining({ id: 'org_1' })
      );
      const stored = fake.all('whatsappMessages') as { messageSid: string; organizationId: string }[];
      expect(stored).toEqual([expect.objectContaining({ messageSid: 'SM_test', organizationId: 'org_1' })]);
    });

    it('explica el error de Twilio en lenguaje claro', async () => {
      withTemplate();
      jest.spyOn(whatsappService, 'sendTemplate').mockRejectedValue(twilioError(63007));

      const response = await send('POST', '/config/test-message', { to: '+584120000000' });

      expect(response.status).toBe(502);
      expect((await response.json()).error).toMatchObject({
        code: 'TWILIO_ERROR',
        twilioCode: 63007,
        message: expect.stringContaining('no está registrado en WhatsApp'),
      });
    });
  });
});

describe('organizaciones nuevas', () => {
  it('no heredan las plantillas antiguas del servidor', () => {
    process.env.TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V = 'HX_de_otra_cuenta';
    try {
      const organization: Organization = {
        id: 'org_new',
        name: 'Nueva',
        active: true,
        twilio: { accountSid: ACCOUNT_SID, authToken: 'token', phoneNumber: '+584111111111' },
        whatsappNotifications: createInitialWhatsAppNotifications(),
        createdAt: new Date(),
      };

      expect(getWhatsAppConfigurationReadiness(organization)).toMatchObject({
        ready: false,
        missing: expect.arrayContaining(['Plantilla de recordatorio']),
        usingLegacyTemplates: false,
      });
    } finally {
      delete process.env.TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V;
    }
  });
});
