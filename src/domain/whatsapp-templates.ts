import type { OrganizationWhatsAppRules, WhatsAppMode } from './entities';

/**
 * Datos que una plantilla puede mostrar. Para usar uno nuevo, añádelo aquí y pásalo en el
 * contexto al enviar.
 */
const TEMPLATE_VARIABLES = {
  clientName: { description: 'nombre del cliente', sample: 'María Pérez' },
  organizationName: { description: 'nombre del negocio', sample: 'Internet Los Andes' },
  serviceCode: { description: 'código del servicio', sample: 'KIT28J720NS8' },
  dueDate: { description: 'fecha de vencimiento', sample: '2026-12-15' },
} as const;

export type WhatsAppTemplateVariable = keyof typeof TEMPLATE_VARIABLES;
/** `organizationName` lo pone el servidor: solo lo usan las plantillas de la plataforma. */
export type WhatsAppTemplateContext = Record<Exclude<WhatsAppTemplateVariable, 'organizationName'>, string> & {
  organizationName?: string;
};

interface WhatsAppTemplateText {
  defaultBody: string;
  /** En orden: la primera es `{{1}}`, la segunda `{{2}}`, etc. */
  variables: readonly WhatsAppTemplateVariable[];
}

interface WhatsAppTemplateDefinition extends WhatsAppTemplateText {
  label: string;
  /** Prefijo del nombre en WhatsApp: minúsculas, números y guiones bajos. */
  templateName: string;
  /**
   * Texto para la cuenta de la plataforma: un mismo número avisa por varios negocios,
   * así que el mensaje debe decir cuál escribe.
   */
  platform: WhatsAppTemplateText;
  /** Si una regla activa la necesita para enviar. Omítelo si solo se usa bajo demanda. */
  requiredWhen?: (rules: OrganizationWhatsAppRules) => boolean;
}

/**
 * Única definición de las plantillas: añadir una entrada basta para que se pueda solicitar
 * desde la configuración, activar al aprobarse y enviar por su clave.
 */
const TEMPLATES = {
  reminder: {
    label: 'Recordatorio de pago',
    templateName: 'payment_reminder',
    defaultBody:
      'Hola {{1}}, te recordamos que tu pago vence el {{2}}. Si ya lo realizaste, puedes ignorar este mensaje.',
    variables: ['clientName', 'dueDate'],
    platform: {
      defaultBody:
        'Hola {{1}}, {{2}} te recuerda que tu pago vence el {{3}}. Si ya lo realizaste, puedes ignorar este mensaje.',
      variables: ['clientName', 'organizationName', 'dueDate'],
    },
    requiredWhen: (rules) => rules.reminderDaysBefore.length > 0,
  },
  dueDateWarning: {
    label: 'Aviso de vencimiento',
    templateName: 'due_date_warning',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} tiene un período vencido desde el {{3}}. Por favor, comunícate con nosotros para regularizar el pago.',
    variables: ['clientName', 'serviceCode', 'dueDate'],
    platform: {
      defaultBody:
        'Hola {{1}}, {{2}} te informa que el servicio {{3}} tiene un período vencido desde el {{4}}. Por favor, responde a este mensaje para regularizar el pago.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'dueDate'],
    },
    requiredWhen: (rules) => rules.dueDateWarningEnabled,
  },
  suspensionNotice: {
    label: 'Aviso de suspensión',
    templateName: 'suspension_notice',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} fue suspendido por falta de pago. Comunícate con nosotros para reactivarlo.',
    variables: ['clientName', 'serviceCode'],
    platform: {
      defaultBody:
        'Hola {{1}}, {{2}} te informa que el servicio {{3}} fue suspendido por falta de pago. Responde a este mensaje para reactivarlo.',
      variables: ['clientName', 'organizationName', 'serviceCode'],
    },
    requiredWhen: (rules) => rules.suspensionNoticeEnabled,
  },
} satisfies Record<string, WhatsAppTemplateDefinition>;

export type WhatsAppTemplateKey = keyof typeof TEMPLATES;

export const WHATSAPP_TEMPLATE_CATALOG: Record<WhatsAppTemplateKey, WhatsAppTemplateDefinition> = TEMPLATES;

export const WHATSAPP_TEMPLATE_KEYS = Object.keys(TEMPLATES) as WhatsAppTemplateKey[];

export function isWhatsAppTemplateKey(value: unknown): value is WhatsAppTemplateKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

/** El texto y las variables de una plantilla según la cuenta que la envía. */
export function getTemplateText(key: WhatsAppTemplateKey, mode: WhatsAppMode = 'own'): WhatsAppTemplateText {
  const definition = WHATSAPP_TEMPLATE_CATALOG[key];
  return mode === 'platform' ? definition.platform : definition;
}

export function describeTemplateVariable(variable: WhatsAppTemplateVariable): string {
  return TEMPLATE_VARIABLES[variable].description;
}

export function sampleTemplateVariable(variable: WhatsAppTemplateVariable): string {
  return TEMPLATE_VARIABLES[variable].sample;
}

/** Convierte los datos con nombre en las variables posicionales que espera Twilio. */
export function buildTemplateVariables(
  key: WhatsAppTemplateKey,
  context: WhatsAppTemplateContext,
  mode: WhatsAppMode = 'own'
): Record<string, string> {
  return Object.fromEntries(
    getTemplateText(key, mode).variables.map((variable, index) => [String(index + 1), context[variable] ?? ''])
  );
}

/** Datos de ejemplo; `overrides` sustituye los que ya se conocen, como el nombre real del negocio. */
export function buildTemplateSamples(
  key: WhatsAppTemplateKey,
  mode: WhatsAppMode = 'own',
  overrides: Partial<Record<WhatsAppTemplateVariable, string>> = {}
): Record<string, string> {
  return Object.fromEntries(
    getTemplateText(key, mode).variables.map((variable, index) => [
      String(index + 1),
      overrides[variable] ?? TEMPLATE_VARIABLES[variable].sample,
    ])
  );
}
