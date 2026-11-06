import {
  BusinessError,
  Organization,
  OrganizationWhatsAppConfig,
  OrganizationWhatsAppTemplateKey,
  OrganizationWhatsAppTemplateRequest,
  WhatsAppTemplateRequestStatus,
} from '../domain/entities';
import { organizationRepository, schedulerLogRepository, whatsappMessageRepository } from './repositories';
import { isFirestoreIndexError } from './firestore-error';
import { resolveWhatsAppNotificationConfig } from './whatsapp-configuration';
import {
  extractTwilioError,
  getWhatsAppWebhookUrls,
  resolveTwilioCredentials,
  TwilioCredentials,
  whatsappService,
} from './whatsapp-service';

interface TemplateVariable {
  description: string;
  sample: string;
}

interface TemplateDefinition {
  label: string;
  templateName: string;
  defaultBody: string;
  /** Posicionales: el índice + 1 es el número de la variable en la plantilla. */
  variables: TemplateVariable[];
}

const CLIENT_NAME: TemplateVariable = { description: 'nombre del cliente', sample: 'María Pérez' };
const SERVICE_CODE: TemplateVariable = { description: 'código del servicio', sample: 'KIT28J720NS8' };
const DUE_DATE: TemplateVariable = { description: 'fecha de vencimiento', sample: '2026-12-15' };

/** Debe coincidir con las variables que envía `buildNotificationVariables` en el scheduler. */
export const WHATSAPP_TEMPLATE_CATALOG: Record<OrganizationWhatsAppTemplateKey, TemplateDefinition> = {
  reminder: {
    label: 'Recordatorio de pago',
    templateName: 'payment_reminder',
    defaultBody:
      'Hola {{1}}, te recordamos que tu pago vence el {{2}}. Si ya lo realizaste, puedes ignorar este mensaje.',
    variables: [CLIENT_NAME, DUE_DATE],
  },
  dueDateWarning: {
    label: 'Aviso de vencimiento',
    templateName: 'due_date_warning',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} tiene un período vencido desde el {{3}}. Por favor, comunícate con nosotros para regularizar el pago.',
    variables: [CLIENT_NAME, SERVICE_CODE, DUE_DATE],
  },
  suspensionNotice: {
    label: 'Aviso de suspensión',
    templateName: 'suspension_notice',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} fue suspendido por falta de pago. Comunícate con nosotros para reactivarlo.',
    variables: [CLIENT_NAME, SERVICE_CODE],
  },
};

export const WHATSAPP_TEMPLATE_KEYS = Object.keys(
  WHATSAPP_TEMPLATE_CATALOG
) as OrganizationWhatsAppTemplateKey[];

const MAX_TEMPLATE_BODY_LENGTH = 1024;
const TWILIO_AUTH_ERROR_CODE = 20003;

const TWILIO_ERROR_DESCRIPTIONS: Record<number, string> = {
  [TWILIO_AUTH_ERROR_CODE]:
    'Twilio rechazó las credenciales. Revisa el Account SID y el Auth Token.',
  20404: 'Twilio no encontró la plantilla o el número en esta cuenta. Revisa que pertenezcan a ella.',
  21211: 'El número de teléfono del cliente no es válido.',
  21408: 'La cuenta de Twilio no tiene permiso para enviar a ese país.',
  21610: 'El cliente bloqueó los mensajes de este número.',
  21656: 'La plantilla no coincide con las variables que envía la app. Solicita una plantilla nueva.',
  63003: 'WhatsApp no pudo entregar el mensaje a ese número.',
  63007: 'El número configurado no está registrado en WhatsApp dentro de esta cuenta de Twilio.',
  63016: 'WhatsApp solo permite plantillas aprobadas fuera de la ventana de 24 horas.',
  63018: 'Se superó el límite de envíos de WhatsApp. Reintenta más tarde.',
  63024: 'El número del cliente no es un destinatario válido de WhatsApp.',
  63027: 'WhatsApp no pudo entregar la plantilla. Revisa que siga aprobada.',
  63032: 'WhatsApp bloqueó el envío por los límites de mensajes del destinatario.',
  63049: 'Meta decidió no entregar este mensaje al destinatario.',
  63112: 'Meta deshabilitó la cuenta de WhatsApp Business de esta organización.',
};

export function describeWhatsAppError(code: number | undefined, fallback: string): string {
  return (code !== undefined && TWILIO_ERROR_DESCRIPTIONS[code]) || fallback;
}

function requireCredentials(organization: Organization): TwilioCredentials {
  const credentials = resolveTwilioCredentials(organization);
  if (!credentials) {
    throw new BusinessError(
      'WHATSAPP_NOT_CONFIGURED',
      'Conecta primero la cuenta de Twilio de esta organización.'
    );
  }
  return credentials;
}

export function isWhatsAppTemplateKey(value: unknown): value is OrganizationWhatsAppTemplateKey {
  return typeof value === 'string' && WHATSAPP_TEMPLATE_KEYS.includes(value as OrganizationWhatsAppTemplateKey);
}

export function validateTemplateBody(key: OrganizationWhatsAppTemplateKey, rawBody: unknown): string {
  const definition = WHATSAPP_TEMPLATE_CATALOG[key];
  const fail = (message: string): BusinessError => new BusinessError('INVALID_WHATSAPP_TEMPLATE', message);

  if (typeof rawBody !== 'string' || !rawBody.trim()) {
    throw fail('Escribe el texto de la plantilla.');
  }
  const body = rawBody.trim();
  if (body.length > MAX_TEMPLATE_BODY_LENGTH) {
    throw fail(`El texto no puede superar ${MAX_TEMPLATE_BODY_LENGTH} caracteres.`);
  }

  const expected = definition.variables.map((_, index) => `{{${index + 1}}}`);
  const found = new Set(body.match(/\{\{[^{}]*\}\}/g) ?? []);
  const missing = expected.filter((variable) => !found.has(variable));
  if (missing.length > 0) {
    throw fail(`Incluye las variables requeridas: ${missing.join(', ')}.`);
  }
  const unknown = [...found].filter((variable) => !expected.includes(variable));
  if (unknown.length > 0) {
    throw fail(`Esta plantilla solo admite ${expected.join(', ')}. Quita ${unknown.join(', ')}.`);
  }
  // WhatsApp rechaza las plantillas que empiezan o terminan con una variable.
  if (body.startsWith('{{') || body.endsWith('}}')) {
    throw fail('El texto no puede empezar ni terminar con una variable.');
  }
  return body;
}

function templateSamples(key: OrganizationWhatsAppTemplateKey): Record<string, string> {
  return Object.fromEntries(
    WHATSAPP_TEMPLATE_CATALOG[key].variables.map((variable, index) => [String(index + 1), variable.sample])
  );
}

/** Cada envío necesita un nombre nuevo: WhatsApp no permite reutilizar el de otra plantilla. */
function buildTemplateName(key: OrganizationWhatsAppTemplateKey, now: Date): string {
  return `${WHATSAPP_TEMPLATE_CATALOG[key].templateName}_${now.getTime().toString(36)}`;
}

function rethrowAsCredentialsError(error: unknown): void {
  if (extractTwilioError(error)?.code === TWILIO_AUTH_ERROR_CODE) {
    throw new BusinessError(
      'INVALID_TWILIO_CREDENTIALS',
      TWILIO_ERROR_DESCRIPTIONS[TWILIO_AUTH_ERROR_CODE]
    );
  }
}

export async function submitTemplateForApproval(
  organization: Organization,
  key: OrganizationWhatsAppTemplateKey,
  rawBody: unknown
): Promise<Organization> {
  const body = validateTemplateBody(key, rawBody ?? WHATSAPP_TEMPLATE_CATALOG[key].defaultBody);
  const credentials = requireCredentials(organization);
  const config = resolveWhatsAppNotificationConfig(organization);
  if (config.templateRequests?.[key]?.status === 'pending') {
    throw new BusinessError(
      'WHATSAPP_TEMPLATE_PENDING',
      'Esta plantilla ya está en revisión. Espera la respuesta de WhatsApp.'
    );
  }

  const now = new Date();
  const name = buildTemplateName(key, now);
  let contentSid: string;
  try {
    contentSid = await whatsappService.createTextTemplate(credentials, {
      friendlyName: name,
      language: 'es',
      body,
      samples: templateSamples(key),
    });
  } catch (error) {
    rethrowAsCredentialsError(error);
    throw error;
  }

  try {
    await whatsappService.submitTemplateForApproval(credentials, contentSid, name);
  } catch (error) {
    // Sin aprobación la plantilla no sirve: no se deja huérfana en la cuenta del cliente.
    await whatsappService.deleteTemplate(credentials, contentSid).catch((deleteError) => {
      console.error(`[WhatsApp] No se pudo borrar la plantilla ${contentSid}:`, deleteError);
    });
    throw error;
  }

  const request: OrganizationWhatsAppTemplateRequest = {
    contentSid,
    name,
    body,
    status: 'pending',
    submittedAt: now.toISOString(),
  };
  return organizationRepository.mutateWhatsAppNotifications(organization.id, (current) => {
    const currentConfig = resolveWhatsAppNotificationConfig(current);
    return {
      ...currentConfig,
      templateRequests: { ...currentConfig.templateRequests, [key]: request },
    };
  });
}

function toRequestStatus(twilioStatus: string): WhatsAppTemplateRequestStatus {
  if (twilioStatus === 'approved') return 'approved';
  if (twilioStatus === 'rejected') return 'rejected';
  if (twilioStatus === 'paused' || twilioStatus === 'disabled') return 'blocked';
  return 'pending';
}

/**
 * Consulta las plantillas en revisión y activa las aprobadas. Un fallo de Twilio deja la
 * solicitud pendiente para el siguiente intento: nunca interrumpe a quien la llama.
 */
export async function syncPendingTemplateRequests(organization: Organization): Promise<Organization> {
  const requests = organization.whatsappNotifications?.templateRequests;
  const credentials = resolveTwilioCredentials(organization);
  if (!requests || !credentials) return organization;

  const pending = WHATSAPP_TEMPLATE_KEYS.filter((key) => requests[key]?.status === 'pending');
  if (pending.length === 0) return organization;

  const changes = new Map<
    OrganizationWhatsAppTemplateKey,
    { contentSid: string; status: WhatsAppTemplateRequestStatus; rejectionReason?: string }
  >();
  await Promise.all(
    pending.map(async (key) => {
      const contentSid = requests[key]!.contentSid;
      try {
        const approval = await whatsappService.fetchTemplateApproval(credentials, contentSid);
        const status = toRequestStatus(approval.status);
        if (status !== 'pending') {
          changes.set(key, { contentSid, status, rejectionReason: approval.rejectionReason });
        }
      } catch (error) {
        console.error(`[WhatsApp] No se pudo consultar la plantilla ${contentSid}:`, error);
      }
    })
  );
  if (changes.size === 0) return organization;

  try {
    return await organizationRepository.mutateWhatsAppNotifications(organization.id, (current) => {
      const config = resolveWhatsAppNotificationConfig(current);
      const templates = { ...config.templates };
      const templateRequests = { ...config.templateRequests };
      for (const [key, change] of changes) {
        const request = templateRequests[key];
        // Pudo reemplazarse mientras se consultaba a Twilio.
        if (request?.contentSid !== change.contentSid) continue;
        templateRequests[key] = {
          ...request,
          status: change.status,
          rejectionReason: change.rejectionReason,
        };
        if (change.status === 'approved') templates[key] = change.contentSid;
      }
      return { ...config, templates, templateRequests };
    });
  } catch (error) {
    console.error(`[WhatsApp] No se pudieron guardar las plantillas de ${organization.id}:`, error);
    return organization;
  }
}

export function toTemplatesResponse(organization: Organization) {
  const config = resolveWhatsAppNotificationConfig(organization);
  return {
    templates: WHATSAPP_TEMPLATE_KEYS.map((key) => {
      const definition = WHATSAPP_TEMPLATE_CATALOG[key];
      return {
        key,
        label: definition.label,
        defaultBody: definition.defaultBody,
        variables: definition.variables.map((variable, index) => ({
          placeholder: `{{${index + 1}}}`,
          description: variable.description,
        })),
        activeContentSid: config.templates[key] ?? null,
        request: config.templateRequests?.[key] ?? null,
      };
    }),
  };
}

export type WhatsAppConnectionStatus =
  | 'not_configured'
  | 'invalid_credentials'
  | 'sender_not_found'
  | 'sender_offline'
  | 'unverified'
  | 'ok';

export interface WhatsAppConnectionCheck {
  status: WhatsAppConnectionStatus;
  message: string;
  /** `null` cuando no se pudo comprobar. */
  inboundWebhookConnected: boolean | null;
}

export async function checkWhatsAppConnection(organization: Organization): Promise<WhatsAppConnectionCheck> {
  const credentials = resolveTwilioCredentials(organization);
  if (!credentials) {
    return {
      status: 'not_configured',
      message: 'Falta conectar la cuenta de Twilio.',
      inboundWebhookConnected: null,
    };
  }

  try {
    await whatsappService.verifyAccount(credentials);
  } catch (error) {
    if (extractTwilioError(error)?.code === TWILIO_AUTH_ERROR_CODE) {
      return {
        status: 'invalid_credentials',
        message: TWILIO_ERROR_DESCRIPTIONS[TWILIO_AUTH_ERROR_CODE],
        inboundWebhookConnected: null,
      };
    }
    console.error('[WhatsApp] No se pudo verificar la cuenta de Twilio:', error);
    return {
      status: 'unverified',
      message: 'No pudimos comunicarnos con Twilio. Inténtalo de nuevo en unos minutos.',
      inboundWebhookConnected: null,
    };
  }

  try {
    const sender = await whatsappService.findSender(credentials);
    if (!sender) {
      return {
        status: 'sender_not_found',
        message: `La cuenta es válida, pero ${credentials.phoneNumber} no aparece como número de WhatsApp en ella.`,
        inboundWebhookConnected: null,
      };
    }
    const webhookUrls = getWhatsAppWebhookUrls();
    const inboundWebhookConnected = webhookUrls ? sender.callbackUrl === webhookUrls.inbound : null;
    if (!sender.status.startsWith('ONLINE')) {
      return {
        status: 'sender_offline',
        message: `El número existe, pero WhatsApp aún no lo tiene activo (estado: ${sender.status}).`,
        inboundWebhookConnected,
      };
    }
    return { status: 'ok', message: 'Cuenta y número verificados con Twilio.', inboundWebhookConnected };
  } catch (error) {
    console.error('[WhatsApp] No se pudo consultar el número en Twilio:', error);
    return {
      status: 'unverified',
      message: 'Las credenciales son válidas, pero no pudimos comprobar el número. El mensaje de prueba lo confirma.',
      inboundWebhookConnected: null,
    };
  }
}

/** Solo rechaza lo que Twilio niega: una caída de su API no debe impedir guardar. */
export async function assertTwilioCredentialsAccepted(credentials: TwilioCredentials): Promise<void> {
  try {
    await whatsappService.verifyAccount(credentials);
  } catch (error) {
    rethrowAsCredentialsError(error);
    console.error('[WhatsApp] No se pudieron verificar las credenciales al guardar:', error);
  }
}

/**
 * La prueba usa una plantilla activa con datos de ejemplo porque quien prueba normalmente
 * no ha escrito al número en las últimas 24 horas.
 */
export function pickTestTemplate(
  config: OrganizationWhatsAppConfig
): { key: OrganizationWhatsAppTemplateKey; contentSid: string; variables: Record<string, string> } {
  const key = WHATSAPP_TEMPLATE_KEYS.find((candidate) => config.templates[candidate]);
  if (!key) {
    throw new BusinessError(
      'WHATSAPP_TEMPLATE_REQUIRED',
      'Necesitas al menos una plantilla aprobada para enviar una prueba.'
    );
  }
  return { key, contentSid: config.templates[key]!, variables: templateSamples(key) };
}

export interface WhatsAppFailureGroup {
  message: string;
  errorCode?: number;
  count: number;
  lastAt: string;
  /** Hasta tres destinatarios afectados, para que el admin pueda reconocer el caso. */
  recipients: string[];
}

const FAILURE_WINDOW_DAYS = 7;
const MAX_FAILURE_RECIPIENTS = 3;

export async function listRecentWhatsAppFailures(
  organizationId: string,
  now = new Date()
): Promise<WhatsAppFailureGroup[]> {
  const since = new Date(now.getTime() - FAILURE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const [logs, failedMessages] = await Promise.all([
    schedulerLogRepository.listByOrganization(organizationId, FAILURE_WINDOW_DAYS * 2),
    whatsappMessageRepository.listFailedSince(organizationId, since).catch((error) => {
      // Mientras se crea el índice se siguen mostrando los fallos del job.
      if (isFirestoreIndexError(error)) {
        console.error('[WhatsApp] Índice de mensajes fallidos en construcción:', (error as Error).message);
        return [];
      }
      throw error;
    }),
  ]);

  const groups = new Map<string, WhatsAppFailureGroup>();
  const add = (input: { at: Date; recipient: string; errorCode?: number; fallback: string }): void => {
    const message = describeWhatsAppError(input.errorCode, input.fallback);
    const group = groups.get(message);
    const at = input.at.toISOString();
    if (!group) {
      groups.set(message, {
        message,
        errorCode: input.errorCode,
        count: 1,
        lastAt: at,
        recipients: [input.recipient],
      });
      return;
    }
    group.count += 1;
    if (at > group.lastAt) group.lastAt = at;
    if (group.recipients.length < MAX_FAILURE_RECIPIENTS && !group.recipients.includes(input.recipient)) {
      group.recipients.push(input.recipient);
    }
  };

  for (const log of logs) {
    if (log.startedAt < since) continue;
    for (const failure of log.notificationFailures ?? []) {
      add({
        at: log.startedAt,
        recipient: failure.clientName || failure.phone,
        errorCode: failure.errorCode,
        fallback: failure.errorMessage,
      });
    }
  }
  for (const message of failedMessages) {
    // El callback de estado guarda `ErrorMessage` o, si no viene, solo el código.
    const parsedCode = Number(message.errorMessage);
    add({
      at: message.createdAt,
      recipient: message.phone,
      errorCode: Number.isInteger(parsedCode) && parsedCode > 0 ? parsedCode : undefined,
      fallback: message.errorMessage || 'WhatsApp no pudo entregar el mensaje.',
    });
  }

  return [...groups.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}
