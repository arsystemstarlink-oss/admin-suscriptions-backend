import {
  Organization,
  OrganizationWhatsAppConfig,
  OrganizationWhatsAppTemplates,
  WhatsAppMode,
} from '../domain/entities';
import {
  getPortalBaseUrl,
  isLegacyTemplate,
  WHATSAPP_CURRENT_TEMPLATE_KEYS,
  WHATSAPP_NOTIFICATION_CATEGORIES,
  WHATSAPP_TEMPLATE_CATALOG,
} from '../domain/whatsapp-templates';

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

/** El modo se guarda por plantilla porque una cuenta migrada puede conservar SIDs anteriores. */
export function resolveWhatsAppTemplateMode(
  organization: Organization,
  key: keyof typeof WHATSAPP_TEMPLATE_CATALOG
): WhatsAppMode {
  return (
    organization.whatsappNotifications?.templateModes?.[key] ??
    (organization.id === PLATFORM_WHATSAPP_ID ? 'platform' : resolveWhatsAppMode(organization))
  );
}

/**
 * Con cuántos días de antelación se puede recordar un vencimiento. El día del vencimiento
 * tiene su propio aviso, así que no hay recordatorios más cercanos.
 */
export const REMINDER_DAY_OPTIONS: readonly number[] = [3, 5, 7];

/** Completa las reglas guardadas antes de que existieran las dos nuevas. */
function normalizeRules(rules: OrganizationWhatsAppConfig['rules']): OrganizationWhatsAppConfig['rules'] {
  const days = (rules.reminderDaysBefore ?? []).filter((day) => REMINDER_DAY_OPTIONS.includes(day));
  return {
    reminderDaysBefore: days,
    dueDateWarningEnabled: rules.dueDateWarningEnabled ?? true,
    suspensionNoticeEnabled: rules.suspensionNoticeEnabled ?? true,
    overdueReminderEnabled: rules.overdueReminderEnabled ?? true,
    paymentConfirmationEnabled: rules.paymentConfirmationEnabled ?? true,
  };
}

export const DEFAULT_WHATSAPP_RULES: OrganizationWhatsAppConfig['rules'] = {
  reminderDaysBefore: [3],
  dueDateWarningEnabled: true,
  suspensionNoticeEnabled: true,
  overdueReminderEnabled: true,
  paymentConfirmationEnabled: true,
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
    rules: normalizeRules(saved?.rules ?? DEFAULT_WHATSAPP_RULES),
    templates: saved?.templates ?? legacyTemplates,
    ...(saved?.templateModes ? { templateModes: saved.templateModes } : {}),
    ...(saved?.templateRequests ? { templateRequests: saved.templateRequests } : {}),
    ...(saved?.lastTestAt ? { lastTestAt: saved.lastTestAt } : {}),
  };
}

/** Si la categoría tiene al menos una plantilla activa: V2 (con o sin botón) o la anterior. */
export function isCategoryTemplateActive(
  templates: OrganizationWhatsAppTemplates,
  category: keyof typeof WHATSAPP_NOTIFICATION_CATEGORIES
): boolean {
  const definition = WHATSAPP_NOTIFICATION_CATEGORIES[category];
  return Boolean(
    templates[definition.buttonKey] ||
      templates[definition.noButtonKey] ||
      (definition.legacyKey && templates[definition.legacyKey])
  );
}

/** Las plantillas con botón activas necesitan la dirección pública y el slug del negocio. */
function portalRequirements(
  organization: Organization,
  templates: OrganizationWhatsAppTemplates
): string[] {
  const missing: string[] = [];
  const usesButton = WHATSAPP_CURRENT_TEMPLATE_KEYS.some(
    (key) => !isLegacyTemplate(key) && WHATSAPP_TEMPLATE_CATALOG[key].button && templates[key]
  );
  if (!usesButton) return missing;
  if (!getPortalBaseUrl()) missing.push('Dirección pública del portal (PORTAL_BASE_URL)');
  if (organization.id !== PLATFORM_WHATSAPP_ID && !organization.slug) {
    missing.push('Enlace del portal del negocio (slug de la organización)');
  }
  return missing;
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
  for (const [category, definition] of Object.entries(WHATSAPP_NOTIFICATION_CATEGORIES)) {
    if (
      definition.legacyKey &&
      definition.requiredWhen(config.rules) &&
      !isCategoryTemplateActive(config.templates, category as keyof typeof WHATSAPP_NOTIFICATION_CATEGORIES)
    ) {
      missing.push(`Plantilla de ${definition.label.toLowerCase()}`);
    }
  }
  missing.push(...portalRequirements(organization, config.templates));

  return {
    ready: missing.length === 0,
    missing,
    usingLegacyTemplates: !organization.whatsappNotifications,
  };
}
