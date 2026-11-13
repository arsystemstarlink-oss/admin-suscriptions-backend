import {
  Organization,
  OrganizationWhatsAppConfig,
  OrganizationWhatsAppTemplates,
  WhatsAppMode,
} from '../domain/entities';
import { WHATSAPP_TEMPLATE_CATALOG, WHATSAPP_TEMPLATE_KEYS } from '../domain/whatsapp-templates';

/** Identificador de la cuenta de WhatsApp de la plataforma: no es una organización real. */
export const PLATFORM_WHATSAPP_ID = '__platform__';

/**
 * Bandeja del super-admin: chats que llegaron al número de la plataforma y no se pudieron
 * atribuir a ninguna organización. Ocupa el lugar del id de organización, sin ser una.
 */
export const UNASSIGNED_WHATSAPP_ID = '__unassigned__';

/** Con qué cuenta envía una organización. Las anteriores a este modo conservan la suya si la tenían. */
export function resolveWhatsAppMode(organization: Organization): WhatsAppMode {
  if (organization.id === PLATFORM_WHATSAPP_ID) return 'platform';
  return organization.whatsappMode ?? (organization.twilio?.accountSid ? 'own' : 'platform');
}

/**
 * Qué textos gestiona una cuenta. Una organización siempre gestiona las plantillas de su propia
 * cuenta, aunque hoy envíe con la plataforma; solo la plataforma usa las que nombran al negocio.
 */
export function accountTemplateMode(organization: Organization): WhatsAppMode {
  return organization.id === PLATFORM_WHATSAPP_ID ? 'platform' : 'own';
}

export const DEFAULT_WHATSAPP_RULES: OrganizationWhatsAppConfig['rules'] = {
  reminderDaysBefore: [3],
  dueDateWarningEnabled: true,
  suspensionNoticeEnabled: true,
};

/**
 * Configuración de una organización nueva. Guardarla explícita evita que herede las
 * plantillas antiguas del servidor, cuyos SID pertenecen a otra cuenta de Twilio.
 */
export function createInitialWhatsAppNotifications(): OrganizationWhatsAppConfig {
  return { rules: { ...DEFAULT_WHATSAPP_RULES }, templates: {} };
}

const LEGACY_TEMPLATE_ENV: OrganizationWhatsAppTemplates = {
  reminder: 'TWILIO_TEMPLATE_SUBSCRIPTION_REMINDER_3DAYS_2V',
  dueDateWarning: 'TWILIO_TEMPLATE_SUBSCRIPTION_CUTOFF_DAY_2V',
  suspensionNotice: 'TWILIO_TEMPLATE_SUBSCRIPTION_SUSPENDED_NOTICE_2V',
};

export function resolveWhatsAppNotificationConfig(
  organization: Organization
): OrganizationWhatsAppConfig {
  const saved = organization.whatsappNotifications;
  const legacyTemplates = Object.fromEntries(
    Object.entries(LEGACY_TEMPLATE_ENV).map(([key, envName]) => [
      key,
      process.env[envName] || undefined,
    ])
  ) as OrganizationWhatsAppTemplates;

  return {
    rules: saved?.rules ?? DEFAULT_WHATSAPP_RULES,
    templates: saved?.templates ?? legacyTemplates,
    ...(saved?.templateRequests ? { templateRequests: saved.templateRequests } : {}),
    ...(saved?.lastTestAt ? { lastTestAt: saved.lastTestAt } : {}),
  };
}

export function getWhatsAppConfigurationReadiness(
  organization: Organization,
  config = resolveWhatsAppNotificationConfig(organization)
): { ready: boolean; missing: string[]; usingLegacyTemplates: boolean } {
  const missing: string[] = [];
  const twilio = organization.twilio;

  if (twilio?.enabled === false) missing.push('Twilio está deshabilitado');
  if (!twilio?.accountSid) missing.push('Account SID de Twilio');
  if (!twilio?.authToken) missing.push('Auth Token de Twilio');
  if (!twilio?.phoneNumber) missing.push('Número de WhatsApp de Twilio');
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    const { label, requiredWhen } = WHATSAPP_TEMPLATE_CATALOG[key];
    if (requiredWhen?.(config.rules) && !config.templates[key]) {
      missing.push(`Plantilla de ${label.toLowerCase()}`);
    }
  }

  return {
    ready: missing.length === 0,
    missing,
    usingLegacyTemplates: !organization.whatsappNotifications,
  };
}
