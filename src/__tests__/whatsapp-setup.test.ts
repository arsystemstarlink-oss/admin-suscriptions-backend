import RequestClient from 'twilio/lib/base/RequestClient';
import { Organization, SchedulerLog, WhatsAppMessage } from '../domain/entities';
import {
  organizationRepository,
  schedulerLogRepository,
  whatsappMessageRepository,
} from '../infrastructure/repositories';
import { getWhatsAppWebhookUrls, TwilioCredentials, whatsappService } from '../infrastructure/whatsapp-service';
import { createInitialWhatsAppNotifications } from '../infrastructure/whatsapp-configuration';
import {
  checkWhatsAppConnection,
  listRecentWhatsAppFailures,
  pickTestTemplate,
  submitTemplateForApproval,
  syncPendingTemplateRequests,
  validateTemplateBody,
} from '../infrastructure/whatsapp-setup';
import {
  buildTemplateSamples,
  buildTemplateVariables,
  WHATSAPP_TEMPLATE_CATALOG,
  WHATSAPP_TEMPLATE_KEYS,
} from '../domain/whatsapp-templates';

jest.mock('../infrastructure/repositories', () => ({
  organizationRepository: { mutateWhatsAppNotifications: jest.fn() },
  schedulerLogRepository: { listByOrganization: jest.fn() },
  whatsappMessageRepository: { listFailedSince: jest.fn() },
}));

const mutate = organizationRepository.mutateWhatsAppNotifications as jest.Mock;

function makeOrganization(overrides: Partial<Organization> = {}): Organization {
  return {
    id: 'org_A',
    name: 'Org A',
    active: true,
    twilio: { accountSid: 'AC_a', authToken: 'token_a', phoneNumber: '+584111111111', enabled: true },
    whatsappNotifications: createInitialWhatsAppNotifications(),
    createdAt: new Date(),
    ...overrides,
  };
}

function twilioError(code: number): Error {
  return Object.assign(new Error(`Twilio ${code}`), { code, status: 400 });
}

const pendingRequest = {
  contentSid: 'HX_new',
  name: 'payment_reminder_x',
  body: 'Hola {{1}}, vence {{2}}.',
  status: 'pending' as const,
  submittedAt: '2026-11-01T00:00:00.000Z',
};

beforeEach(() => {
  jest.restoreAllMocks();
  mutate.mockReset();
  mutate.mockImplementation(async (_id, change) => {
    const organization = lastOrganization;
    return { ...organization, whatsappNotifications: change(organization) };
  });
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

let lastOrganization: Organization;
function given(overrides: Partial<Organization> = {}): Organization {
  lastOrganization = makeOrganization(overrides);
  return lastOrganization;
}

describe('catálogo de plantillas', () => {
  it.each(WHATSAPP_TEMPLATE_KEYS)('%s es una definición válida', (key) => {
    const definition = WHATSAPP_TEMPLATE_CATALOG[key];

    expect(definition.templateName).toMatch(/^[a-z0-9_]+$/);
    expect(new Set(definition.variables).size).toBe(definition.variables.length);
    expect(() => validateTemplateBody(key, definition.defaultBody)).not.toThrow();
    expect(Object.keys(buildTemplateSamples(key))).toHaveLength(definition.variables.length);
  });

  it('convierte los datos con nombre al orden de cada plantilla', () => {
    const context = { clientName: 'Ana', serviceCode: 'KIT1', dueDate: '2026-12-01' };

    expect(buildTemplateVariables('reminder', context)).toEqual({ '1': 'Ana', '2': '2026-12-01' });
    expect(buildTemplateVariables('dueDateWarning', context)).toEqual({ '1': 'Ana', '2': 'KIT1', '3': '2026-12-01' });
    expect(buildTemplateVariables('suspensionNotice', context)).toEqual({ '1': 'Ana', '2': 'KIT1' });
  });
});

describe('validateTemplateBody', () => {
  it('acepta los textos predeterminados de todas las plantillas', () => {
    for (const [key, definition] of Object.entries(WHATSAPP_TEMPLATE_CATALOG)) {
      expect(validateTemplateBody(key as keyof typeof WHATSAPP_TEMPLATE_CATALOG, definition.defaultBody)).toBe(
        definition.defaultBody
      );
    }
  });

  it.each([
    ['falta una variable', 'Hola {{1}}, tu pago vence pronto.', /\{\{2\}\}/],
    ['variable que la app no envía', 'Hola {{1}}, vence el {{2}} por {{3}}.', /Quita \{\{3\}\}/],
    ['variable con nombre', 'Hola {{nombre}} y {{1}}, vence el {{2}}.', /Quita \{\{nombre\}\}/],
    ['empieza con variable', '{{1}}, tu pago vence el {{2}}.', /empezar ni terminar/],
    ['termina con variable', 'Hola {{1}}, tu pago vence el {{2}}', /empezar ni terminar/],
    ['vacío', '   ', /Escribe/],
  ])('rechaza: %s', (_name, body, message) => {
    expect(() => validateTemplateBody('reminder', body)).toThrow(message);
  });
});

describe('submitTemplateForApproval', () => {
  it('crea la plantilla, la envía a revisión y no la activa todavía', async () => {
    const create = jest.spyOn(whatsappService, 'createTextTemplate').mockResolvedValue('HX_new');
    const submit = jest.spyOn(whatsappService, 'submitTemplateForApproval').mockResolvedValue();

    const updated = await submitTemplateForApproval(given(), 'reminder', undefined);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ accountSid: 'AC_a' }),
      expect.objectContaining({
        language: 'es',
        body: WHATSAPP_TEMPLATE_CATALOG.reminder.defaultBody,
        samples: { '1': 'María Pérez', '2': '2026-12-15' },
      })
    );
    expect(submit.mock.calls[0][2]).toMatch(/^payment_reminder_[a-z0-9]+$/);
    expect(updated.whatsappNotifications?.templates.reminder).toBeUndefined();
    expect(updated.whatsappNotifications?.templateRequests?.reminder).toMatchObject({
      contentSid: 'HX_new',
      status: 'pending',
    });
  });

  it('no permite una segunda solicitud mientras otra sigue en revisión', async () => {
    const create = jest.spyOn(whatsappService, 'createTextTemplate');
    const organization = given({
      whatsappNotifications: {
        ...createInitialWhatsAppNotifications(),
        templateRequests: { reminder: pendingRequest },
      },
    });

    await expect(submitTemplateForApproval(organization, 'reminder', undefined)).rejects.toMatchObject({
      code: 'WHATSAPP_TEMPLATE_PENDING',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('borra la plantilla creada si Twilio rechaza la solicitud de aprobación', async () => {
    jest.spyOn(whatsappService, 'createTextTemplate').mockResolvedValue('HX_new');
    jest.spyOn(whatsappService, 'submitTemplateForApproval').mockRejectedValue(twilioError(20001));
    const remove = jest.spyOn(whatsappService, 'deleteTemplate').mockResolvedValue();

    await expect(submitTemplateForApproval(given(), 'reminder', undefined)).rejects.toMatchObject({ code: 20001 });

    expect(remove).toHaveBeenCalledWith(expect.anything(), 'HX_new');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('traduce el rechazo de credenciales de Twilio', async () => {
    jest.spyOn(whatsappService, 'createTextTemplate').mockRejectedValue(twilioError(20003));

    await expect(submitTemplateForApproval(given(), 'reminder', undefined)).rejects.toMatchObject({
      code: 'INVALID_TWILIO_CREDENTIALS',
    });
  });
});

describe('syncPendingTemplateRequests', () => {
  const withPending = () =>
    given({
      whatsappNotifications: {
        rules: createInitialWhatsAppNotifications().rules,
        templates: { reminder: 'HX_old' },
        templateRequests: { reminder: pendingRequest },
      },
    });

  it('no consulta a Twilio si no hay solicitudes pendientes', async () => {
    const fetchApproval = jest.spyOn(whatsappService, 'fetchTemplateApproval');
    const organization = given();

    await expect(syncPendingTemplateRequests(organization)).resolves.toBe(organization);
    expect(fetchApproval).not.toHaveBeenCalled();
  });

  it('activa la plantilla aprobada', async () => {
    jest.spyOn(whatsappService, 'fetchTemplateApproval').mockResolvedValue({ status: 'approved' });

    const updated = await syncPendingTemplateRequests(withPending());

    expect(updated.whatsappNotifications?.templates.reminder).toBe('HX_new');
    expect(updated.whatsappNotifications?.templateRequests?.reminder?.status).toBe('approved');
  });

  it('conserva la plantilla activa cuando la nueva es rechazada', async () => {
    jest
      .spyOn(whatsappService, 'fetchTemplateApproval')
      .mockResolvedValue({ status: 'rejected', rejectionReason: 'Texto ambiguo' });

    const updated = await syncPendingTemplateRequests(withPending());

    expect(updated.whatsappNotifications?.templates.reminder).toBe('HX_old');
    expect(updated.whatsappNotifications?.templateRequests?.reminder).toMatchObject({
      status: 'rejected',
      rejectionReason: 'Texto ambiguo',
    });
  });

  it.each(['received', 'pending', ''])('sigue pendiente con el estado "%s"', async (status) => {
    jest.spyOn(whatsappService, 'fetchTemplateApproval').mockResolvedValue({ status });
    const organization = withPending();

    await expect(syncPendingTemplateRequests(organization)).resolves.toBe(organization);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('no falla si Twilio no responde', async () => {
    jest.spyOn(whatsappService, 'fetchTemplateApproval').mockRejectedValue(new Error('caído'));
    const organization = withPending();

    await expect(syncPendingTemplateRequests(organization)).resolves.toBe(organization);
  });

  it('ignora el resultado si la solicitud se reemplazó durante la consulta', async () => {
    const organization = withPending();
    jest.spyOn(whatsappService, 'fetchTemplateApproval').mockResolvedValue({ status: 'approved' });
    lastOrganization = makeOrganization({
      whatsappNotifications: {
        rules: createInitialWhatsAppNotifications().rules,
        templates: { reminder: 'HX_manual' },
        templateRequests: {},
      },
    });

    const updated = await syncPendingTemplateRequests(organization);

    expect(updated.whatsappNotifications?.templates.reminder).toBe('HX_manual');
  });
});

describe('checkWhatsAppConnection', () => {
  const originalBaseUrl = process.env.BASE_URL;
  afterEach(() => {
    process.env.BASE_URL = originalBaseUrl;
  });

  it('informa credenciales rechazadas sin consultar el número', async () => {
    jest.spyOn(whatsappService, 'verifyAccount').mockRejectedValue(twilioError(20003));
    const findSender = jest.spyOn(whatsappService, 'findSender');

    await expect(checkWhatsAppConnection(given())).resolves.toMatchObject({ status: 'invalid_credentials' });
    expect(findSender).not.toHaveBeenCalled();
  });

  it('no culpa a las credenciales si Twilio está caído', async () => {
    jest.spyOn(whatsappService, 'verifyAccount').mockRejectedValue(new Error('timeout'));

    await expect(checkWhatsAppConnection(given())).resolves.toMatchObject({ status: 'unverified' });
  });

  it('detecta un número que no pertenece a la cuenta', async () => {
    jest.spyOn(whatsappService, 'verifyAccount').mockResolvedValue();
    jest.spyOn(whatsappService, 'findSender').mockResolvedValue(undefined);

    await expect(checkWhatsAppConnection(given())).resolves.toMatchObject({ status: 'sender_not_found' });
  });

  it('confirma la conexión y compara la URL de mensajes entrantes', async () => {
    process.env.BASE_URL = 'https://api.example.com';
    jest.spyOn(whatsappService, 'verifyAccount').mockResolvedValue();
    const findSender = jest
      .spyOn(whatsappService, 'findSender')
      .mockResolvedValue({ status: 'ONLINE', callbackUrl: 'https://api.example.com/communications/webhook' });

    await expect(checkWhatsAppConnection(given())).resolves.toEqual(
      expect.objectContaining({ status: 'ok', inboundWebhookConnected: true })
    );

    findSender.mockResolvedValue({ status: 'ONLINE', callbackUrl: 'https://otro.example.com/hook' });
    await expect(checkWhatsAppConnection(given())).resolves.toEqual(
      expect.objectContaining({ status: 'ok', inboundWebhookConnected: false })
    );
  });

  it('avisa si el número aún no está activo', async () => {
    jest.spyOn(whatsappService, 'verifyAccount').mockResolvedValue();
    jest.spyOn(whatsappService, 'findSender').mockResolvedValue({ status: 'TWILIO_REVIEW' });

    await expect(checkWhatsAppConnection(given())).resolves.toMatchObject({ status: 'sender_offline' });
  });
});

describe('getWhatsAppWebhookUrls', () => {
  const originalBaseUrl = process.env.BASE_URL;
  afterEach(() => {
    process.env.BASE_URL = originalBaseUrl;
  });

  it('no ofrece URLs que Twilio no pueda alcanzar', () => {
    process.env.BASE_URL = 'http://localhost:3000';
    expect(getWhatsAppWebhookUrls()).toBeNull();
  });

  it('quita la barra final de BASE_URL', () => {
    process.env.BASE_URL = 'https://api.example.com/';
    expect(getWhatsAppWebhookUrls()).toEqual({
      inbound: 'https://api.example.com/communications/webhook',
      status: 'https://api.example.com/communications/status',
    });
  });
});

describe('pickTestTemplate', () => {
  it('exige una plantilla activa', () => {
    expect(() => pickTestTemplate(createInitialWhatsAppNotifications())).toThrow(/plantilla aprobada/);
  });

  it('envía las variables de ejemplo de la plantilla elegida', () => {
    const picked = pickTestTemplate({
      ...createInitialWhatsAppNotifications(),
      templates: { suspensionNotice: 'HX_s' },
    });

    expect(picked).toEqual({
      key: 'suspensionNotice',
      contentSid: 'HX_s',
      variables: { '1': 'María Pérez', '2': 'KIT28J720NS8' },
    });
  });
});

describe('listRecentWhatsAppFailures', () => {
  const now = new Date('2026-11-06T12:00:00.000Z');
  const log = (startedAt: string, failures: SchedulerLog['notificationFailures']): SchedulerLog =>
    ({ startedAt: new Date(startedAt), notificationFailures: failures }) as SchedulerLog;
  const failedMessage = (createdAt: string, errorMessage: string, phone = '+584120000001'): WhatsAppMessage =>
    ({ createdAt: new Date(createdAt), errorMessage, phone }) as WhatsAppMessage;

  it('agrupa por causa y traduce los códigos de Twilio', async () => {
    (schedulerLogRepository.listByOrganization as jest.Mock).mockResolvedValue([
      log('2026-11-06T08:00:00.000Z', [
        { type: 'reminder', clientName: 'Ana', phone: '+1', errorCode: 21656, errorMessage: 'crudo' },
        { type: 'reminder', clientName: 'Luis', phone: '+2', errorCode: 21656, errorMessage: 'crudo' },
      ]),
      log('2026-10-01T08:00:00.000Z', [
        { type: 'reminder', clientName: 'Viejo', phone: '+3', errorMessage: 'fuera de la ventana' },
      ]),
    ]);
    (whatsappMessageRepository.listFailedSince as jest.Mock).mockResolvedValue([
      failedMessage('2026-11-05T08:00:00.000Z', '63024'),
    ]);

    const failures = await listRecentWhatsAppFailures('org_A', now);

    expect(failures).toEqual([
      expect.objectContaining({ errorCode: 21656, count: 2, recipients: ['Ana', 'Luis'] }),
      expect.objectContaining({
        errorCode: 63024,
        count: 1,
        message: expect.stringContaining('no es un destinatario válido'),
      }),
    ]);
    expect(failures.map((failure) => failure.message).join()).not.toContain('fuera de la ventana');
  });

  it('sigue mostrando los fallos del job mientras se construye el índice', async () => {
    (schedulerLogRepository.listByOrganization as jest.Mock).mockResolvedValue([
      log('2026-11-06T08:00:00.000Z', [{ type: 'reminder', clientName: 'Ana', phone: '+1', errorMessage: 'Sin plantilla' }]),
    ]);
    (whatsappMessageRepository.listFailedSince as jest.Mock).mockRejectedValue(
      Object.assign(new Error('The query requires an index'), { name: 'GoogleError', code: 9 })
    );

    await expect(listRecentWhatsAppFailures('org_A', now)).resolves.toEqual([
      expect.objectContaining({ message: 'Sin plantilla' }),
    ]);
  });
});

describe('peticiones reales del SDK de Twilio', () => {
  const credentials: TwilioCredentials = {
    accountSid: 'ACaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    authToken: 'token_wire',
    phoneNumber: '+584111111111',
  };
  const originalBaseUrl = process.env.BASE_URL;
  let request: jest.SpyInstance;

  beforeEach(() => {
    request = jest.spyOn(RequestClient.prototype, 'request');
  });
  afterEach(() => {
    process.env.BASE_URL = originalBaseUrl;
  });

  const respondWith = (statusCode: number, body: unknown): void => {
    request.mockResolvedValue({ statusCode, body: JSON.stringify(body), headers: {} });
  };
  const sentJson = (call = 0): any => {
    const { data } = request.mock.calls[call][0];
    return typeof data === 'string' ? JSON.parse(data) : data;
  };

  it('crea la plantilla con los nombres de campo de la API', async () => {
    respondWith(201, { sid: 'HX_wire' });

    await expect(
      whatsappService.createTextTemplate(credentials, {
        friendlyName: 'payment_reminder_x',
        language: 'es',
        body: 'Hola {{1}}',
        samples: { '1': 'María' },
      })
    ).resolves.toBe('HX_wire');

    expect(request.mock.calls[0][0]).toMatchObject({
      method: 'post',
      uri: 'https://content.twilio.com/v1/Content',
    });
    expect(sentJson()).toEqual({
      friendly_name: 'payment_reminder_x',
      language: 'es',
      variables: { '1': 'María' },
      types: { 'twilio/text': { body: 'Hola {{1}}' } },
    });
  });

  it('solicita la aprobación de WhatsApp como UTILITY', async () => {
    respondWith(201, { name: 'x', category: 'UTILITY', status: 'received' });

    await whatsappService.submitTemplateForApproval(credentials, 'HX_wire', 'payment_reminder_x');

    expect(request.mock.calls[0][0].uri.toLowerCase()).toBe(
      'https://content.twilio.com/v1/content/hx_wire/approvalrequests/whatsapp'
    );
    expect(sentJson()).toEqual({ name: 'payment_reminder_x', category: 'UTILITY' });
  });

  it('lee el estado y el motivo de rechazo', async () => {
    respondWith(200, {
      sid: 'HX_wire',
      account_sid: credentials.accountSid,
      whatsapp: { status: 'rejected', rejection_reason: 'Texto ambiguo' },
      url: 'https://content.twilio.com/v1/Content/HX_wire/ApprovalRequests',
    });

    await expect(whatsappService.fetchTemplateApproval(credentials, 'HX_wire')).resolves.toEqual({
      status: 'rejected',
      rejectionReason: 'Texto ambiguo',
    });
  });

  it('encuentra el número y su URL de mensajes entrantes', async () => {
    respondWith(200, {
      senders: [
        {
          sid: 'XE1',
          status: 'ONLINE',
          sender_id: 'whatsapp:+584111111111',
          webhook: { callback_url: 'https://api.example.com/communications/webhook' },
        },
      ],
      meta: { key: 'senders', next_page_url: null },
    });

    await expect(whatsappService.findSender(credentials)).resolves.toEqual({
      status: 'ONLINE',
      callbackUrl: 'https://api.example.com/communications/webhook',
    });
  });

  it('pide el callback de estado en cada mensaje cuando hay URL pública', async () => {
    process.env.BASE_URL = 'https://api.example.com';
    respondWith(201, { sid: 'SM1' });

    await whatsappService.sendTemplate(
      { to: '+584120000000', templateName: 'HX1', variables: { '1': 'a' } },
      makeOrganization({ twilio: { ...credentials, enabled: true } })
    );

    expect(request.mock.calls[0][0].data).toMatchObject({
      StatusCallback: 'https://api.example.com/communications/status',
      ContentSid: 'HX1',
    });
  });

  it('no pide el callback de estado en local', async () => {
    process.env.BASE_URL = 'http://localhost:3000';
    respondWith(201, { sid: 'SM1' });

    await whatsappService.sendTemplate(
      { to: '+584120000000', templateName: 'HX1' },
      makeOrganization({ twilio: { ...credentials, enabled: true } })
    );

    expect(request.mock.calls[0][0].data.StatusCallback).toBeUndefined();
  });
});
