import express, { NextFunction, Request, Response } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { createFakeFirestore } from './support/fake-firestore';
import whatsappConfigRouter from '../api/routes/whatsapp-config';
import whatsappRouter from '../api/routes/whatsapp';
import { errorHandler } from '../api/middleware/error-handler';
import { whatsappService } from '../infrastructure/whatsapp-service';
import { claimUnassignedChat } from '../infrastructure/whatsapp-platform';
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
    app.use('/api/whatsapp', whatsappRouter);
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

  it('GET /config/templates indica el ejemplo de cada dato y si una regla activa la necesita', async () => {
    fake.clear();
    seedOrganization({
      whatsappNotifications: { rules: { ...rules, suspensionNoticeEnabled: false }, templates: {} },
    });

    const { templates } = await (await send('GET', '/config/templates')).json();

    expect(templates.find((template: any) => template.key === 'reminder')).toMatchObject({
      required: true,
      variables: [
        { placeholder: '{{1}}', description: 'nombre del cliente', sample: 'María Pérez' },
        { placeholder: '{{2}}', description: 'fecha de vencimiento', sample: '2026-12-15' },
      ],
    });
    expect(templates.find((template: any) => template.key === 'suspensionNotice').required).toBe(false);
  });

  describe('WhatsApp de la plataforma', () => {
    const originalTtl = process.env.PLATFORM_WHATSAPP_CACHE_TTL_MS;
    const usageMonth = new Date().toISOString().slice(0, 7);

    beforeAll(() => {
      process.env.PLATFORM_WHATSAPP_CACHE_TTL_MS = '0';
    });
    afterAll(() => {
      process.env.PLATFORM_WHATSAPP_CACHE_TTL_MS = originalTtl;
    });

    const seedPlatformMode = (overrides: Record<string, unknown> = {}) => {
      fake.clear();
      seedOrganization({ twilio: undefined, ...overrides });
      fake.seed('platform', {
        id: 'whatsapp',
        twilio: {
          accountSid: `AC${'b'.repeat(32)}`,
          authToken: 'platform-token-1234567',
          phoneNumber: '+584000000000',
          enabled: true,
        },
        whatsappNotifications: { rules, templates: { dueDateWarning: 'HX_platform_due' } },
      });
    };

    it('una organización sin cuenta propia envía con la plataforma y ve su cupo, nunca las credenciales', async () => {
      seedPlatformMode();

      const config = await storedConfig();

      expect(config).toMatchObject({
        mode: 'platform',
        platform: { available: true, phoneNumber: '+584000000000', usage: { used: 0, limit: 300 } },
        readiness: { ready: false },
      });
      expect(config.readiness.missing).toEqual([
        'El recordatorio de pago aún no está disponible en la plataforma',
        'El aviso de suspensión aún no está disponible en la plataforma',
      ]);
      expect(JSON.stringify(config)).not.toContain('platform-token');
      expect(config.platform.templates.find((template: any) => template.key === 'dueDateWarning')).toMatchObject({
        contentSid: 'HX_platform_due',
        body: expect.stringContaining('{{2}} te informa'),
      });
    });

    it('la prueba sale por la cuenta de la plataforma, nombra al negocio y descuenta el cupo', async () => {
      seedPlatformMode();
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate').mockResolvedValue('SM_platform');

      const response = await send('POST', '/config/test-message', { to: '+584120000000' });

      expect(response.status).toBe(201);
      expect(sendTemplate).toHaveBeenCalledWith(
        {
          to: '+584120000000',
          templateName: 'HX_platform_due',
          variables: { '1': 'María Pérez', '2': 'ORG', '3': 'KIT28J720NS8', '4': '2026-12-15' },
        },
        expect.objectContaining({ id: 'org_1', twilio: expect.objectContaining({ phoneNumber: '+584000000000' }) })
      );
      expect((await storedConfig()).platform.usage).toMatchObject({ month: usageMonth, used: 1 });
    });

    it('no envía más cuando se agota el cupo del mes', async () => {
      seedPlatformMode({ whatsappUsage: { month: usageMonth, count: 300 } });
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate');

      const response = await send('POST', '/config/test-message', { to: '+584120000000' });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('WHATSAPP_LIMIT_REACHED');
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    it('el cupo vuelve a empezar al cambiar de mes', async () => {
      seedPlatformMode({ whatsappUsage: { month: '2020-01', count: 300 } });

      expect((await storedConfig()).platform.usage).toMatchObject({ month: usageMonth, used: 0 });
    });

    it('POST /send con templateKey usa la plantilla central y pone el nombre del negocio', async () => {
      seedPlatformMode();
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate').mockResolvedValue('SM_platform');

      const response = await send('POST', '/send', {
        to: '+584120000000',
        templateKey: 'dueDateWarning',
        context: { clientName: 'Ana López', serviceCode: 'KIT1', dueDate: '2026-12-01', organizationName: 'Otra' },
      });

      expect(response.status).toBe(201);
      expect(sendTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          templateName: 'HX_platform_due',
          variables: { '1': 'Ana López', '2': 'ORG', '3': 'KIT1', '4': '2026-12-01' },
        }),
        expect.anything()
      );
    });

    it('la organización puede pasar a su propio número y entonces se le piden sus datos', async () => {
      seedPlatformMode();

      const response = await send('PUT', '/config', { mode: 'own' });

      expect(response.status).toBe(200);
      const config = await response.json();
      expect(config.mode).toBe('own');
      expect(config.readiness.missing).toContain('Account SID de Twilio');
      expect((await storedConfig()).mode).toBe('own');
    });

    it('la respuesta de un cliente al número central llega a la organización que le escribió', async () => {
      seedPlatformMode();
      fake.seed('whatsappConversations', {
        id: 'org_1__+584120000000',
        organizationId: 'org_1',
        phone: '+584120000000',
        messageCount: 1,
        lastMessage: { direction: 'OUTBOUND', createdAt: new Date() },
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      const validateWebhook = jest.spyOn(whatsappService, 'validateWebhook').mockReturnValue(true);

      const response = await send('POST', '/webhook', {
        From: 'whatsapp:+584120000000',
        To: 'whatsapp:+584000000000',
        Body: 'Ya pagué',
        MessageSid: 'SM_inbound',
      });

      expect(response.status).toBe(200);
      // La firma se comprueba con el token de la plataforma, no con el de la organización.
      expect(validateWebhook.mock.calls[0][3]).toBe('platform-token-1234567');
      expect(fake.all('whatsappMessages')).toEqual([
        expect.objectContaining({ direction: 'INBOUND', organizationId: 'org_1', body: 'Ya pagué' }),
      ]);
    });

    describe('a quién le llega un mensaje al número central', () => {
      const PHONE = '+584120000000';
      let sid = 0;

      const seedClient = (organizationId: string) =>
        fake.seed('clients', {
          id: `client_${organizationId}`,
          organizationId,
          firstName: 'Ana',
          lastName: 'Pérez',
          phone: PHONE,
          createdAt: new Date(),
        });
      const seedConversation = (organizationId: string, lastMessageAt: Date) =>
        fake.seed('whatsappConversations', {
          id: `${organizationId}__${PHONE}`,
          organizationId,
          phone: PHONE,
          messageCount: 1,
          lastMessage: { direction: 'OUTBOUND', createdAt: lastMessageAt },
          createdAt: lastMessageAt,
          updatedAt: lastMessageAt,
        });
      const seedSecondOrganization = (overrides: Record<string, unknown> = {}) =>
        seedOrganization({ id: 'org_2', slug: 'org-2', twilio: undefined, ...overrides });
      const receive = async (): Promise<string | undefined> => {
        jest.spyOn(whatsappService, 'validateWebhook').mockReturnValue(true);
        const messageSid = `SM_routing_${++sid}`;
        const response = await send('POST', '/webhook', {
          From: `whatsapp:${PHONE}`,
          To: 'whatsapp:+584000000000',
          Body: 'Hola',
          MessageSid: messageSid,
        });
        expect(response.status).toBe(200);
        const stored = fake.read('whatsappMessages', `inbound_${messageSid}`) as { organizationId?: string };
        return stored.organizationId;
      };

      it('un número que nadie conoce queda en la bandeja sin asignar del super-admin', async () => {
        seedPlatformMode();

        expect(await receive()).toBe('__unassigned__');
        expect(fake.read('whatsappConversations', `__unassigned____${PHONE}`)).toMatchObject({
          organizationId: '__unassigned__',
          hasUnread: true,
        });
      });

      it('el cliente registrado en una organización le llega a ella aunque nunca le hayan escrito', async () => {
        seedPlatformMode();
        seedClient('org_1');

        expect(await receive()).toBe('org_1');
        expect(fake.read('whatsappMessages', `inbound_SM_routing_${sid}`)).toMatchObject({ clientId: 'client_org_1' });
      });

      it('estar registrado pesa más que la última conversación con otra organización', async () => {
        seedPlatformMode();
        seedSecondOrganization();
        seedClient('org_1');
        seedConversation('org_2', new Date());

        expect(await receive()).toBe('org_1');
      });

      it('si es cliente de dos organizaciones, va a la que le escribió más recientemente', async () => {
        seedPlatformMode();
        seedSecondOrganization();
        seedClient('org_1');
        seedClient('org_2');
        seedConversation('org_1', new Date('2026-11-01T00:00:00.000Z'));
        seedConversation('org_2', new Date('2026-11-10T00:00:00.000Z'));

        expect(await receive()).toBe('org_2');
      });

      it('si es cliente de dos organizaciones y ninguna le ha escrito, decide el super-admin', async () => {
        seedPlatformMode();
        seedSecondOrganization();
        seedClient('org_1');
        seedClient('org_2');

        expect(await receive()).toBe('__unassigned__');
      });

      it('no cuenta la organización que usa su propio número ni la desactivada', async () => {
        seedPlatformMode();
        seedSecondOrganization({ whatsappMode: 'own' });
        seedOrganization({ id: 'org_3', slug: 'org-3', twilio: undefined, active: false });
        seedClient('org_2');
        seedClient('org_3');
        seedConversation('org_3', new Date());

        expect(await receive()).toBe('__unassigned__');
      });

      it('al registrar el cliente, su organización recibe el chat sin asignar con su historial', async () => {
        seedPlatformMode();
        await receive();
        await receive();
        seedClient('org_1');

        const claimed = await claimUnassignedChat({ id: 'client_org_1', organizationId: 'org_1', phone: PHONE });

        expect(claimed).toBe(true);
        expect(fake.all('whatsappMessages')).toEqual([
          expect.objectContaining({ organizationId: 'org_1', clientId: 'client_org_1' }),
          expect.objectContaining({ organizationId: 'org_1', clientId: 'client_org_1' }),
        ]);
        expect(fake.read('whatsappConversations', `__unassigned____${PHONE}`)).toBeUndefined();
        expect(fake.read('whatsappConversations', `org_1__${PHONE}`)).toMatchObject({
          organizationId: 'org_1',
          clientId: 'client_org_1',
          messageCount: 2,
          hasUnread: true,
          lastMessage: { organizationId: 'org_1' },
        });
        // Los siguientes mensajes ya le llegan directo.
        expect(await receive()).toBe('org_1');
      });

      it('no mueve el chat si otra organización de la plataforma tiene el mismo teléfono', async () => {
        seedPlatformMode();
        seedSecondOrganization();
        await receive();
        seedClient('org_1');
        seedClient('org_2');

        expect(await claimUnassignedChat({ id: 'client_org_1', organizationId: 'org_1', phone: PHONE })).toBe(false);
        expect(fake.read('whatsappConversations', `__unassigned____${PHONE}`)).toBeDefined();
      });

      it('un admin de organización no puede asignar chats', async () => {
        seedPlatformMode();
        await receive();

        const response = await send('POST', `/conversations/${encodeURIComponent(PHONE)}/assign`, {
          organizationId: 'org_1',
        });

        expect(response.status).toBe(403);
        expect(fake.read('whatsappConversations', `__unassigned____${PHONE}`)).toBeDefined();
      });
    });

    it('una organización con su cuenta de Twilio sigue en modo propio sin tocar nada', async () => {
      expect((await storedConfig()).mode).toBe('own');
    });
  });

  describe('POST /config/webhooks/connect', () => {
    it('conecta el número y responde con la conexión comprobada', async () => {
      process.env.BASE_URL = 'https://api.example.com';
      const inboundUrl = 'https://api.example.com/communications/webhook';
      jest.spyOn(whatsappService, 'verifyAccount').mockResolvedValue();
      jest
        .spyOn(whatsappService, 'findSender')
        .mockResolvedValueOnce({ sid: 'XE1', status: 'ONLINE' })
        .mockResolvedValue({ sid: 'XE1', status: 'ONLINE', callbackUrl: inboundUrl });
      const setWebhook = jest.spyOn(whatsappService, 'setSenderInboundWebhook').mockResolvedValue();

      const response = await send('POST', '/config/webhooks/connect');

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: 'ok',
        inboundWebhookConnected: true,
        inboundWebhookUrl: inboundUrl,
      });
      expect(setWebhook).toHaveBeenCalledWith(expect.anything(), 'XE1', inboundUrl);
    });

    it('exige tener la cuenta de Twilio conectada', async () => {
      fake.clear();
      seedOrganization({ twilio: undefined });

      const response = await send('POST', '/config/webhooks/connect');

      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('WHATSAPP_NOT_CONFIGURED');
    });
  });

  describe('POST /config/templates/submit-missing', () => {
    it('solicita solo las que nunca se pidieron', async () => {
      fake.clear();
      seedOrganization({
        whatsappNotifications: {
          rules,
          templates: { reminder: 'HX_active' },
          templateRequests: { suspensionNotice: { ...pendingRequest, status: 'rejected' } },
        },
      });
      const create = jest.spyOn(whatsappService, 'createTextTemplate').mockResolvedValue('HX_new');
      jest.spyOn(whatsappService, 'submitTemplateForApproval').mockResolvedValue();

      const response = await send('POST', '/config/templates/submit-missing');

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.submitted).toEqual(['dueDateWarning']);
      expect(body.failed).toEqual([]);
      expect(create).toHaveBeenCalledTimes(1);
      expect(body.templates.find((t: { key: string }) => t.key === 'suspensionNotice').request.status).toBe('rejected');
    });

    it('sigue con las demás si una falla y conserva las que sí salieron', async () => {
      jest
        .spyOn(whatsappService, 'createTextTemplate')
        .mockResolvedValueOnce('HX_1')
        .mockRejectedValueOnce(twilioError(63018))
        .mockResolvedValueOnce('HX_3');
      jest.spyOn(whatsappService, 'submitTemplateForApproval').mockResolvedValue();

      const body = await (await send('POST', '/config/templates/submit-missing')).json();

      expect(body.submitted).toEqual(['reminder', 'suspensionNotice']);
      expect(body.failed).toEqual([
        expect.objectContaining({ key: 'dueDateWarning', message: expect.stringContaining('límite de envíos') }),
      ]);
      const stored = fake.read('organizations', 'org_1') as unknown as Organization;
      expect(Object.keys(stored.whatsappNotifications?.templateRequests ?? {}).sort()).toEqual([
        'reminder',
        'suspensionNotice',
      ]);
    });

    it('con credenciales rechazadas informa una sola vez', async () => {
      const create = jest.spyOn(whatsappService, 'createTextTemplate').mockRejectedValue(twilioError(20003));

      const response = await send('POST', '/config/templates/submit-missing');

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_TWILIO_CREDENTIALS');
      expect(create).toHaveBeenCalledTimes(1);
    });

    it('no hace nada si no falta ninguna', async () => {
      fake.clear();
      seedOrganization({
        whatsappNotifications: {
          rules,
          templates: { reminder: 'HX_a', dueDateWarning: 'HX_b', suspensionNotice: 'HX_c' },
        },
      });
      const create = jest.spyOn(whatsappService, 'createTextTemplate');

      const response = await send('POST', '/config/templates/submit-missing');

      expect(response.status).toBe(200);
      expect((await response.json()).submitted).toEqual([]);
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe('POST /send con templateKey', () => {
    const context = { clientName: 'Ana López', serviceCode: 'KIT1', dueDate: '2026-12-01' };
    const withTemplate = () => {
      fake.clear();
      seedOrganization({ whatsappNotifications: { rules, templates: { dueDateWarning: 'HX_due' } } });
    };

    it('resuelve el SID y el orden de las variables en el servidor', async () => {
      withTemplate();
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate').mockResolvedValue('SM_key');

      const response = await send('POST', '/send', { to: '+584120000000', templateKey: 'dueDateWarning', context });

      expect(response.status).toBe(201);
      expect(sendTemplate).toHaveBeenCalledWith(
        {
          to: '+584120000000',
          templateName: 'HX_due',
          variables: { '1': 'Ana López', '2': 'KIT1', '3': '2026-12-01' },
        },
        expect.objectContaining({ id: 'org_1' })
      );
      expect(fake.all('whatsappMessages')).toEqual([expect.objectContaining({ templateName: 'HX_due' })]);
    });

    it('no envía si faltan datos que la plantilla necesita', async () => {
      withTemplate();
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate');

      const response = await send('POST', '/send', {
        to: '+584120000000',
        templateKey: 'dueDateWarning',
        context: { clientName: 'Ana López' },
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error.message).toContain('código del servicio, fecha de vencimiento');
      expect(sendTemplate).not.toHaveBeenCalled();
    });

    it('avisa si la plantilla aún no está activa', async () => {
      const response = await send('POST', '/send', { to: '+584120000000', templateKey: 'reminder', context });

      expect(response.status).toBe(409);
      expect((await response.json()).error.code).toBe('WHATSAPP_TEMPLATE_REQUIRED');
    });

    it.each(['otra', '__proto__', 'constructor', 7])('rechaza la clave %s', async (templateKey) => {
      const response = await send('POST', '/send', { to: '+584120000000', templateKey, context });

      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_DATA');
    });

    it('sigue aceptando templateName y variables directos', async () => {
      const sendTemplate = jest.spyOn(whatsappService, 'sendTemplate').mockResolvedValue('SM_raw');

      const response = await send('POST', '/send', {
        to: '+584120000000',
        templateName: 'HX_raw',
        variables: { '1': 'x' },
      });

      expect(response.status).toBe(201);
      expect(sendTemplate.mock.calls[0][0]).toMatchObject({ templateName: 'HX_raw', variables: { '1': 'x' } });
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

    it('recuerda la prueba enviada aunque después se guarden las reglas', async () => {
      withTemplate();
      jest.spyOn(whatsappService, 'sendTemplate').mockResolvedValue('SM_test');
      expect((await storedConfig()).lastTestAt).toBeNull();

      await send('POST', '/config/test-message', { to: '+584120000000' });
      const { lastTestAt } = await storedConfig();
      expect(Number.isNaN(Date.parse(lastTestAt))).toBe(false);

      const saved = await send('PUT', '/config', { rules: { reminderDaysBefore: [5] } });
      expect(await saved.json()).toMatchObject({ lastTestAt, templates: { dueDateWarning: 'HX_due' } });
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
        missing: expect.arrayContaining(['Plantilla de recordatorio de pago']),
        usingLegacyTemplates: false,
      });
    } finally {
      delete process.env.TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V;
    }
  });
});
