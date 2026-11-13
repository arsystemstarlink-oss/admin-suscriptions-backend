import { BusinessError, Organization } from '../domain/entities';
import { resolveWhatsAppMonthlyLimit } from '../domain/business-plan';
import { WHATSAPP_TEMPLATE_CATALOG, WHATSAPP_TEMPLATE_KEYS, getTemplateText } from '../domain/whatsapp-templates';
import {
  organizationRepository,
  platformWhatsAppRepository,
  whatsappConversationRepository,
} from './repositories';
import {
  PLATFORM_WHATSAPP_ID,
  resolveWhatsAppMode,
  resolveWhatsAppNotificationConfig,
} from './whatsapp-configuration';
import { normalizePhoneNumber, resolveTwilioCredentials } from './whatsapp-service';
import { syncPendingTemplateRequests, toTemplateVariablesResponse } from './whatsapp-setup';

/**
 * La cuenta de WhatsApp de la plataforma, con la forma de una organización para reutilizar
 * la configuración, las plantillas y los envíos. Activa las plantillas aprobadas al leerla,
 * porque esta cuenta no tiene un job diario propio que lo haga.
 */
export async function getPlatformWhatsAppAccount(): Promise<Organization> {
  const account = await platformWhatsAppRepository.get();
  const pending = Object.values(account.whatsappNotifications?.templateRequests ?? {}).some(
    (request) => request?.status === 'pending'
  );
  return pending ? syncPendingTemplateRequests(account) : account;
}

/** Si la organización envía con la cuenta de la plataforma y, por tanto, consume su cupo. */
export function isPlatformSender(organization: Organization): boolean {
  return organization.id !== PLATFORM_WHATSAPP_ID && resolveWhatsAppMode(organization) === 'platform';
}

/**
 * La organización tal como debe enviar. En modo plataforma lleva las credenciales y las
 * plantillas centrales junto a sus propias reglas. Es solo para enviar: nunca se guarda.
 */
export async function toSendingOrganization(organization: Organization): Promise<Organization> {
  if (!isPlatformSender(organization)) return organization;
  const platform = await getPlatformWhatsAppAccount();
  return {
    ...organization,
    whatsappMode: 'platform',
    twilio: platform.twilio,
    whatsappNotifications: {
      rules: resolveWhatsAppNotificationConfig(organization).rules,
      templates: resolveWhatsAppNotificationConfig(platform).templates,
    },
  };
}

/** Carga por id lo que hace falta para enviar o para validar un webhook de Twilio. */
export async function loadSendingOrganization(organizationId: string): Promise<Organization | undefined> {
  if (organizationId === PLATFORM_WHATSAPP_ID) return getPlatformWhatsAppAccount();
  const organization = await organizationRepository.getById(organizationId);
  return organization ? toSendingOrganization(organization) : undefined;
}

export function currentUsageMonth(now = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface PlatformWhatsAppUsage {
  /** Mes al que corresponde el contador (YYYY-MM, UTC). */
  month: string;
  used: number;
  limit: number;
}

export function getPlatformWhatsAppUsage(organization: Organization, now = new Date()): PlatformWhatsAppUsage {
  const month = currentUsageMonth(now);
  const stored = organization.whatsappUsage;
  return {
    month,
    used: stored?.month === month ? stored.count : 0,
    limit: resolveWhatsAppMonthlyLimit(organization.plan, organization.clientLimit),
  };
}

/** Mensajes que la organización aún puede enviar este mes; sin tope con cuenta propia. */
export function getRemainingPlatformMessages(organization: Organization, now = new Date()): number {
  if (!isPlatformSender(organization)) return Number.POSITIVE_INFINITY;
  const { used, limit } = getPlatformWhatsAppUsage(organization, now);
  return Math.max(0, limit - used);
}

export function describePlatformLimitReached(limit: number): string {
  return `Alcanzaste el límite de ${limit} mensajes de WhatsApp de este mes. Se renueva el día 1; para enviar más, sube de plan o conecta tu propio número.`;
}

export function assertPlatformQuotaAvailable(organization: Organization, now = new Date()): void {
  if (getRemainingPlatformMessages(organization, now) > 0) return;
  throw new BusinessError(
    'WHATSAPP_LIMIT_REACHED',
    describePlatformLimitReached(getPlatformWhatsAppUsage(organization, now).limit)
  );
}

/** Descuenta un mensaje del cupo. Un fallo al contar no debe hacer fallar un envío ya hecho. */
export async function recordPlatformSend(organization: Organization, now = new Date()): Promise<void> {
  if (!isPlatformSender(organization)) return;
  await organizationRepository.addWhatsAppUsage(organization.id, currentUsageMonth(now), 1).catch((error) => {
    console.error(`[WhatsApp] No se pudo registrar el consumo de ${organization.id}:`, error);
  });
}

/** Qué le falta a una organización para que sus avisos salgan por la cuenta de la plataforma. */
export function getPlatformModeReadiness(
  organization: Organization,
  platform: Organization,
  now = new Date()
): { ready: boolean; missing: string[]; usingLegacyTemplates: boolean } {
  const missing: string[] = [];
  const { rules } = resolveWhatsAppNotificationConfig(organization);
  const platformTemplates = resolveWhatsAppNotificationConfig(platform).templates;

  if (!resolveTwilioCredentials(platform)) {
    missing.push('El WhatsApp de la plataforma todavía no está disponible');
  } else {
    for (const key of WHATSAPP_TEMPLATE_KEYS) {
      const { label, requiredWhen } = WHATSAPP_TEMPLATE_CATALOG[key];
      if (requiredWhen?.(rules) && !platformTemplates[key]) {
        missing.push(`El ${label.toLowerCase()} aún no está disponible en la plataforma`);
      }
    }
  }
  const usage = getPlatformWhatsAppUsage(organization, now);
  if (usage.used >= usage.limit) {
    missing.push(`Alcanzaste el límite de ${usage.limit} mensajes de este mes`);
  }
  return { ready: missing.length === 0, missing, usingLegacyTemplates: false };
}

/** Lo que la organización necesita saber de la cuenta de la plataforma, sin sus secretos. */
export function toPlatformSummary(organization: Organization, platform: Organization, now = new Date()) {
  const config = resolveWhatsAppNotificationConfig(platform);
  return {
    available: Boolean(resolveTwilioCredentials(platform)),
    phoneNumber: platform.twilio?.phoneNumber ?? null,
    usage: getPlatformWhatsAppUsage(organization, now),
    templates: WHATSAPP_TEMPLATE_KEYS.map((key) => {
      const contentSid = config.templates[key] ?? null;
      const request = config.templateRequests?.[key];
      const text = getTemplateText(key, 'platform');
      return {
        key,
        label: WHATSAPP_TEMPLATE_CATALOG[key].label,
        // Solo se conoce el texto aprobado si se solicitó desde la app.
        body: request?.status === 'approved' && request.contentSid === contentSid ? request.body : text.defaultBody,
        variables: toTemplateVariablesResponse(text.variables),
        contentSid,
      };
    }),
  };
}

/**
 * Un mensaje que llega al número de la plataforma no dice a qué negocio va dirigido. Se asigna
 * a la organización que habló por última vez con ese teléfono a través de la plataforma.
 */
export async function resolvePlatformInbound(
  to: string,
  from: string
): Promise<{ platform: Organization; organization?: Organization } | undefined> {
  const platform = await getPlatformWhatsAppAccount();
  const platformNumber = platform.twilio?.phoneNumber ? normalizePhoneNumber(platform.twilio.phoneNumber) : '';
  if (!platformNumber || platformNumber !== normalizePhoneNumber(to)) return undefined;

  const conversations = await whatsappConversationRepository.listByPhone(normalizePhoneNumber(from));
  for (const conversation of conversations) {
    const organization = await organizationRepository.getById(conversation.organizationId);
    if (organization && isPlatformSender(organization)) {
      return { platform, organization: await toSendingOrganization(organization) };
    }
  }
  return { platform };
}
