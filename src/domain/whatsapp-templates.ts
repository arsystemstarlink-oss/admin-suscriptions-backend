import type { OrganizationWhatsAppRules } from './entities';

/**
 * Datos que una plantilla puede mostrar. Para usar uno nuevo, añádelo aquí y pásalo en el
 * contexto al enviar.
 */
const TEMPLATE_VARIABLES = {
  clientName: { description: 'nombre del cliente', sample: 'María Pérez' },
  serviceCode: { description: 'código del servicio', sample: 'KIT28J720NS8' },
  dueDate: { description: 'fecha de vencimiento', sample: '2026-12-15' },
} as const;

export type WhatsAppTemplateVariable = keyof typeof TEMPLATE_VARIABLES;
export type WhatsAppTemplateContext = Record<WhatsAppTemplateVariable, string>;

interface WhatsAppTemplateDefinition {
  label: string;
  /** Prefijo del nombre en WhatsApp: minúsculas, números y guiones bajos. */
  templateName: string;
  defaultBody: string;
  /** En orden: la primera es `{{1}}`, la segunda `{{2}}`, etc. */
  variables: readonly WhatsAppTemplateVariable[];
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
    requiredWhen: (rules) => rules.reminderDaysBefore.length > 0,
  },
  dueDateWarning: {
    label: 'Aviso de vencimiento',
    templateName: 'due_date_warning',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} tiene un período vencido desde el {{3}}. Por favor, comunícate con nosotros para regularizar el pago.',
    variables: ['clientName', 'serviceCode', 'dueDate'],
    requiredWhen: (rules) => rules.dueDateWarningEnabled,
  },
  suspensionNotice: {
    label: 'Aviso de suspensión',
    templateName: 'suspension_notice',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} fue suspendido por falta de pago. Comunícate con nosotros para reactivarlo.',
    variables: ['clientName', 'serviceCode'],
    requiredWhen: (rules) => rules.suspensionNoticeEnabled,
  },
} satisfies Record<string, WhatsAppTemplateDefinition>;

export type WhatsAppTemplateKey = keyof typeof TEMPLATES;

export const WHATSAPP_TEMPLATE_CATALOG: Record<WhatsAppTemplateKey, WhatsAppTemplateDefinition> = TEMPLATES;

export const WHATSAPP_TEMPLATE_KEYS = Object.keys(TEMPLATES) as WhatsAppTemplateKey[];

export function isWhatsAppTemplateKey(value: unknown): value is WhatsAppTemplateKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

export function describeTemplateVariable(variable: WhatsAppTemplateVariable): string {
  return TEMPLATE_VARIABLES[variable].description;
}

/** Convierte los datos con nombre en las variables posicionales que espera Twilio. */
export function buildTemplateVariables(
  key: WhatsAppTemplateKey,
  context: Pick<WhatsAppTemplateContext, WhatsAppTemplateVariable>
): Record<string, string> {
  return Object.fromEntries(
    WHATSAPP_TEMPLATE_CATALOG[key].variables.map((variable, index) => [String(index + 1), context[variable]])
  );
}

export function buildTemplateSamples(key: WhatsAppTemplateKey): Record<string, string> {
  return Object.fromEntries(
    WHATSAPP_TEMPLATE_CATALOG[key].variables.map((variable, index) => [
      String(index + 1),
      TEMPLATE_VARIABLES[variable].sample,
    ])
  );
}
