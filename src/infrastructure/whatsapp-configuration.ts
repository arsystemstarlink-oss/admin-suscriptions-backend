import {
  Organization,
  OrganizationWhatsAppConfig,
  OrganizationWhatsAppTemplates,
} from '../domain/entities';

export const DEFAULT_WHATSAPP_RULES: OrganizationWhatsAppConfig['rules'] = {
  reminderDaysBefore: [3],
  dueDateWarningEnabled: true,
  suspensionNoticeEnabled: true,
};

const LEGACY_TEMPLATE_ENV: Record<keyof OrganizationWhatsAppTemplates, string> = {
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
  if (config.rules.reminderDaysBefore.length > 0 && !config.templates.reminder) {
    missing.push('Plantilla de recordatorio');
  }
  if (config.rules.dueDateWarningEnabled && !config.templates.dueDateWarning) {
    missing.push('Plantilla de aviso de vencimiento');
  }
  if (config.rules.suspensionNoticeEnabled && !config.templates.suspensionNotice) {
    missing.push('Plantilla de aviso de suspensión');
  }

  return {
    ready: missing.length === 0,
    missing,
    usingLegacyTemplates: !organization.whatsappNotifications,
  };
}
