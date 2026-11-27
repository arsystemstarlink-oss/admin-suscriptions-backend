import type { OrganizationWhatsAppRules, WhatsAppMode } from './entities';

/**
 * Datos que una plantilla puede mostrar. Para usar uno nuevo, añádelo aquí y pásalo en el
 * contexto al enviar.
 */
const TEMPLATE_VARIABLES = {
  clientName: { description: 'nombre del cliente', sample: 'María Pérez', scope: 'body' },
  organizationName: { description: 'nombre del negocio', sample: 'Internet Los Andes', scope: 'body' },
  serviceCode: { description: 'número de kit (código del servicio)', sample: 'KIT28J720NS8', scope: 'body' },
  planName: { description: 'nombre del plan', sample: 'Hogar 50 Mbps', scope: 'body' },
  amount: { description: 'monto formateado', sample: 'USD 50,00', scope: 'body' },
  dueDate: { description: 'fecha de vencimiento', sample: '2026-12-15', scope: 'body' },
  daysBefore: { description: 'días antes del vencimiento', sample: '3', scope: 'body' },
  periodLabel: { description: 'período facturado', sample: 'Diciembre 2026', scope: 'body' },
  coveredUntil: { description: 'fecha hasta la que queda cubierto', sample: '15 ene 2027', scope: 'body' },
  serviceStatus: { description: 'estado del servicio tras el pago', sample: 'Activo', scope: 'body' },
  portalSlug: { description: 'enlace del portal del negocio', sample: 'internet-los-andes', scope: 'button' },
} as const;

export type WhatsAppTemplateVariable = keyof typeof TEMPLATE_VARIABLES;
/** `organizationName` y `portalSlug` los pone el servidor: quien envía no puede falsificarlos. */
export type WhatsAppTemplateContext = Partial<Record<WhatsAppTemplateVariable, string>>;

export interface WhatsAppTemplateButton {
  title: string;
  /** Ruta relativa al portal; la base la pone `PORTAL_BASE_URL`. */
  urlTemplate: string;
  variable: Extract<WhatsAppTemplateVariable, 'portalSlug'>;
}

interface WhatsAppTemplateText {
  defaultBody: string;
  /** En orden: la primera es `{{1}}`, la segunda `{{2}}`, etc. La del botón va al final. */
  variables: readonly WhatsAppTemplateVariable[];
}

interface WhatsAppTemplateDefinition extends WhatsAppTemplateText {
  label: string;
  /** Prefijo del nombre en WhatsApp: minúsculas, números y guiones bajos. */
  templateName: string;
  /**
   * Texto para la cuenta de la plataforma. Las plantillas de cobranza usan el mismo texto en
   * todas las cuentas; las legacy conservan su firma porque ya están aprobadas así.
   */
  platform: WhatsAppTemplateText;
  /** Si una regla activa la necesita para enviar. Omítelo si solo se usa bajo demanda. */
  requiredWhen?: (rules: OrganizationWhatsAppRules) => boolean;
  /** Las claves anteriores siguen enviándose como respaldo mientras Meta aprueba las nuevas. */
  legacy?: boolean;
  /** Límite de Twilio: 640 con botón, 1024 en texto simple. */
  maxBodyLength: number;
  button?: WhatsAppTemplateButton;
  /** Ejemplos propios de la plantilla; sustituyen al ejemplo general de esa variable. */
  samples?: Partial<Record<WhatsAppTemplateVariable, string>>;
}

const LEGACY_PLATFORM_TEMPLATE_FOOTER =
  '\n\nA|R SYSTEM\nNotificación automática. Por favor, no respondas a este mensaje.';

const PORTAL_BUTTON_TITLE = 'Ver mi cuenta';
const PORTAL_PATH_TEMPLATE = '/consulta/{{N}}';

/**
 * Única definición de las plantillas: añadir una entrada basta para que se pueda solicitar
 * desde la configuración, activar al aprobarse y enviar por su clave.
 */
const TEMPLATES = {
  reminderV2: {
    label: 'Recordatorio de pago',
    templateName: 'cobranza_recordatorio_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} (plan {{4}}) por {{5}} vence el {{6}}, en {{7}} días. Puedes ver tu cuenta y reportar tu pago con el botón.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate', 'daysBefore', 'portalSlug'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} (plan {{4}}) por {{5}} vence el {{6}}, en {{7}} días. Puedes ver tu cuenta y reportar tu pago con el botón.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate', 'daysBefore', 'portalSlug'],
    },
    maxBodyLength: 640,
    samples: { dueDate: '15 dic 2026' },
    button: { title: PORTAL_BUTTON_TITLE, urlTemplate: PORTAL_PATH_TEMPLATE, variable: 'portalSlug' },
    // La variante sin botón cubre a quien no tiene DNI; no hace falta exigir el botón.
    requiredWhen: (rules) => rules.reminderDaysBefore.length > 0,
  },
  reminderV2NoButton: {
    label: 'Recordatorio de pago (sin botón)',
    templateName: 'cobranza_recordatorio_sin_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} (plan {{4}}) por {{5}} vence el {{6}}, en {{7}} días. Puedes reportar tu pago respondiendo a este mensaje.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate', 'daysBefore'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} (plan {{4}}) por {{5}} vence el {{6}}, en {{7}} días. Puedes reportar tu pago respondiendo a este mensaje.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate', 'daysBefore'],
    },
    maxBodyLength: 1024,
    samples: { dueDate: '15 dic 2026' },
  },
  dueDateWarningV2: {
    label: 'Aviso de vencimiento',
    templateName: 'cobranza_vencimiento_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. Hoy vence el pago de tu servicio {{3}} (plan {{4}}) por {{5}}. Fecha límite: {{6}}. Para evitar la suspensión, reporta tu pago hoy con el botón.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate', 'portalSlug'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. Hoy vence el pago de tu servicio {{3}} (plan {{4}}) por {{5}}. Fecha límite: {{6}}. Para evitar la suspensión, reporta tu pago hoy con el botón.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate', 'portalSlug'],
    },
    maxBodyLength: 640,
    samples: { dueDate: '15 dic 2026' },
    button: { title: PORTAL_BUTTON_TITLE, urlTemplate: PORTAL_PATH_TEMPLATE, variable: 'portalSlug' },
    requiredWhen: (rules) => rules.dueDateWarningEnabled,
  },
  dueDateWarningV2NoButton: {
    label: 'Aviso de vencimiento (sin botón)',
    templateName: 'cobranza_vencimiento_sin_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. Hoy vence el pago de tu servicio {{3}} (plan {{4}}) por {{5}}. Fecha límite: {{6}}. Para evitar la suspensión, reporta tu pago hoy respondiendo a este mensaje.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. Hoy vence el pago de tu servicio {{3}} (plan {{4}}) por {{5}}. Fecha límite: {{6}}. Para evitar la suspensión, reporta tu pago hoy respondiendo a este mensaje.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'planName', 'amount', 'dueDate'],
    },
    maxBodyLength: 1024,
    samples: { dueDate: '15 dic 2026' },
  },
  overdueReminder: {
    label: 'Recordatorio de deuda vencida',
    templateName: 'cobranza_deuda_vencida_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} por {{4}} venció el {{5}} y sigue pendiente. Regulariza hoy para evitar la suspensión. Puedes reportar tu pago con el botón.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate', 'portalSlug'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} por {{4}} venció el {{5}} y sigue pendiente. Regulariza hoy para evitar la suspensión. Puedes reportar tu pago con el botón.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate', 'portalSlug'],
    },
    maxBodyLength: 640,
    samples: { dueDate: '15 dic 2026' },
    button: { title: PORTAL_BUTTON_TITLE, urlTemplate: PORTAL_PATH_TEMPLATE, variable: 'portalSlug' },
    requiredWhen: (rules) => rules.overdueReminderEnabled,
  },
  overdueReminderNoButton: {
    label: 'Recordatorio de deuda vencida (sin botón)',
    templateName: 'cobranza_deuda_vencida_sin_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} por {{4}} venció el {{5}} y sigue pendiente. Regulariza hoy para evitar la suspensión. Puedes reportar tu pago respondiendo a este mensaje.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. El pago de tu servicio {{3}} por {{4}} venció el {{5}} y sigue pendiente. Regulariza hoy para evitar la suspensión. Puedes reportar tu pago respondiendo a este mensaje.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate'],
    },
    maxBodyLength: 1024,
    samples: { dueDate: '15 dic 2026' },
  },
  suspensionNoticeV2: {
    label: 'Aviso de suspensión',
    templateName: 'cobranza_suspension_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. El servicio {{3}} fue suspendido por un saldo pendiente de {{4}} desde el {{5}}. Para reactivarlo, regulariza tu pago y repórtalo con el botón.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate', 'portalSlug'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. El servicio {{3}} fue suspendido por un saldo pendiente de {{4}} desde el {{5}}. Para reactivarlo, regulariza tu pago y repórtalo con el botón.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate', 'portalSlug'],
    },
    maxBodyLength: 640,
    samples: { dueDate: '15 dic 2026' },
    button: { title: PORTAL_BUTTON_TITLE, urlTemplate: PORTAL_PATH_TEMPLATE, variable: 'portalSlug' },
    requiredWhen: (rules) => rules.suspensionNoticeEnabled,
  },
  suspensionNoticeV2NoButton: {
    label: 'Aviso de suspensión (sin botón)',
    templateName: 'cobranza_suspension_sin_boton',
    defaultBody:
      'Hola {{1}}, te escribimos de {{2}}. El servicio {{3}} fue suspendido por un saldo pendiente de {{4}} desde el {{5}}. Para reactivarlo, regulariza tu pago y responde a este mensaje con tu comprobante.',
    variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate'],
    platform: {
      defaultBody:
        'Hola {{1}}, te escribimos de {{2}}. El servicio {{3}} fue suspendido por un saldo pendiente de {{4}} desde el {{5}}. Para reactivarlo, regulariza tu pago y responde a este mensaje con tu comprobante.',
      variables: ['clientName', 'organizationName', 'serviceCode', 'amount', 'dueDate'],
    },
    maxBodyLength: 1024,
    samples: { dueDate: '15 dic 2026' },
  },
  paymentConfirmation: {
    label: 'Confirmación de pago',
    templateName: 'cobranza_pago_confirmado_boton',
    defaultBody:
      'Hola {{1}}, tu pago de {{3}} del período {{4}} para el servicio {{5}} fue registrado por {{2}}. Estado del servicio: {{6}}. Tu servicio queda cubierto hasta el {{7}}. Gracias por tu pago. Puedes ver tu cuenta con el botón.',
    variables: [
      'clientName',
      'organizationName',
      'amount',
      'periodLabel',
      'serviceCode',
      'serviceStatus',
      'coveredUntil',
      'portalSlug',
    ],
    platform: {
      defaultBody:
        'Hola {{1}}, tu pago de {{3}} del período {{4}} para el servicio {{5}} fue registrado por {{2}}. Estado del servicio: {{6}}. Tu servicio queda cubierto hasta el {{7}}. Gracias por tu pago. Puedes ver tu cuenta con el botón.',
      variables: [
        'clientName',
        'organizationName',
        'amount',
        'periodLabel',
        'serviceCode',
        'serviceStatus',
        'coveredUntil',
        'portalSlug',
      ],
    },
    maxBodyLength: 640,
    samples: { periodLabel: 'Diciembre 2026', coveredUntil: '15 ene 2027' },
    button: { title: PORTAL_BUTTON_TITLE, urlTemplate: PORTAL_PATH_TEMPLATE, variable: 'portalSlug' },
    requiredWhen: (rules) => rules.paymentConfirmationEnabled,
  },
  paymentConfirmationNoButton: {
    label: 'Confirmación de pago (sin botón)',
    templateName: 'cobranza_pago_confirmado_sin_boton',
    defaultBody:
      'Hola {{1}}, tu pago de {{3}} del período {{4}} para el servicio {{5}} fue registrado por {{2}}. Estado del servicio: {{6}}. Tu servicio queda cubierto hasta el {{7}}. Gracias por tu pago. Si tienes dudas, responde a este mensaje.',
    variables: ['clientName', 'organizationName', 'amount', 'periodLabel', 'serviceCode', 'serviceStatus', 'coveredUntil'],
    platform: {
      defaultBody:
        'Hola {{1}}, tu pago de {{3}} del período {{4}} para el servicio {{5}} fue registrado por {{2}}. Estado del servicio: {{6}}. Tu servicio queda cubierto hasta el {{7}}. Gracias por tu pago. Si tienes dudas, responde a este mensaje.',
      variables: ['clientName', 'organizationName', 'amount', 'periodLabel', 'serviceCode', 'serviceStatus', 'coveredUntil'],
    },
    maxBodyLength: 1024,
    samples: { periodLabel: 'Diciembre 2026', coveredUntil: '15 ene 2027' },
  },
  reminder: {
    label: 'Recordatorio anterior',
    templateName: 'payment_reminder',
    defaultBody:
      'Hola {{1}}, te recordamos que tu pago vence el {{2}}, asociado al kit {{3}}. Si ya lo realizaste, puedes ignorar este mensaje.',
    variables: ['clientName', 'dueDate', 'serviceCode'],
    platform: {
      defaultBody:
        `Hola {{1}}, {{2}} te recuerda que tu pago vence el {{3}}, asociado al kit {{4}}. Si ya lo realizaste, puedes ignorar este mensaje.${LEGACY_PLATFORM_TEMPLATE_FOOTER}`,
      variables: ['clientName', 'organizationName', 'dueDate', 'serviceCode'],
    },
    maxBodyLength: 1024,
    legacy: true,
  },
  dueDateWarning: {
    label: 'Aviso de vencimiento anterior',
    templateName: 'due_date_warning',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} tiene un período vencido desde el {{3}}. Por favor, comunícate con nosotros para regularizar el pago.',
    variables: ['clientName', 'serviceCode', 'dueDate'],
    platform: {
      defaultBody:
        `Hola {{1}}, {{2}} te informa que el servicio {{3}} tiene un período vencido desde el {{4}}. Por favor, comunícate con nosotros para regularizar el pago.${LEGACY_PLATFORM_TEMPLATE_FOOTER}`,
      variables: ['clientName', 'organizationName', 'serviceCode', 'dueDate'],
    },
    maxBodyLength: 1024,
    legacy: true,
  },
  suspensionNotice: {
    label: 'Aviso de suspensión anterior',
    templateName: 'suspension_notice',
    defaultBody:
      'Hola {{1}}, el servicio {{2}} fue suspendido por falta de pago. Comunícate con nosotros para reactivarlo.',
    variables: ['clientName', 'serviceCode'],
    platform: {
      defaultBody:
        `Hola {{1}}, {{2}} te informa que el servicio {{3}} fue suspendido por falta de pago. Comunícate con nosotros para reactivarlo.${LEGACY_PLATFORM_TEMPLATE_FOOTER}`,
      variables: ['clientName', 'organizationName', 'serviceCode'],
    },
    maxBodyLength: 1024,
    legacy: true,
  },
} satisfies Record<string, WhatsAppTemplateDefinition>;

export type WhatsAppTemplateKey = keyof typeof TEMPLATES;

export const WHATSAPP_TEMPLATE_CATALOG: Record<WhatsAppTemplateKey, WhatsAppTemplateDefinition> = TEMPLATES;

/** Las tres plantillas anteriores: solo se envían como respaldo. */
export const WHATSAPP_LEGACY_TEMPLATE_KEYS = (
  Object.keys(TEMPLATES) as WhatsAppTemplateKey[]
).filter((key) => WHATSAPP_TEMPLATE_CATALOG[key].legacy === true);

export function isLegacyTemplate(key: WhatsAppTemplateKey): boolean {
  return WHATSAPP_TEMPLATE_CATALOG[key].legacy === true;
}

export type WhatsAppNotificationCategory =
  | 'reminder'
  | 'dueDateWarning'
  | 'overdueReminder'
  | 'suspensionNotice'
  | 'paymentConfirmation';

interface WhatsAppNotificationCategoryDefinition {
  label: string;
  /** Variante con botón al portal: cliente con DNI registrado. */
  buttonKey: WhatsAppTemplateKey;
  /** Variante sin botón: cliente sin DNI. También sirve de respaldo si falta la otra. */
  noButtonKey: WhatsAppTemplateKey;
  /** Plantilla anterior que se usa si ninguna V2 está aprobada. */
  legacyKey?: WhatsAppTemplateKey;
  requiredWhen: (rules: OrganizationWhatsAppRules) => boolean;
}

export const WHATSAPP_NOTIFICATION_CATEGORIES: Record<
  WhatsAppNotificationCategory,
  WhatsAppNotificationCategoryDefinition
> = {
  reminder: {
    label: 'Recordatorio de pago',
    buttonKey: 'reminderV2',
    noButtonKey: 'reminderV2NoButton',
    legacyKey: 'reminder',
    requiredWhen: (rules) => rules.reminderDaysBefore.length > 0,
  },
  dueDateWarning: {
    label: 'Aviso de vencimiento',
    buttonKey: 'dueDateWarningV2',
    noButtonKey: 'dueDateWarningV2NoButton',
    legacyKey: 'dueDateWarning',
    requiredWhen: (rules) => rules.dueDateWarningEnabled,
  },
  overdueReminder: {
    label: 'Recordatorio de deuda vencida',
    buttonKey: 'overdueReminder',
    noButtonKey: 'overdueReminderNoButton',
    requiredWhen: (rules) => rules.overdueReminderEnabled,
  },
  suspensionNotice: {
    label: 'Aviso de suspensión',
    buttonKey: 'suspensionNoticeV2',
    noButtonKey: 'suspensionNoticeV2NoButton',
    legacyKey: 'suspensionNotice',
    requiredWhen: (rules) => rules.suspensionNoticeEnabled,
  },
  paymentConfirmation: {
    label: 'Confirmación de pago',
    buttonKey: 'paymentConfirmation',
    noButtonKey: 'paymentConfirmationNoButton',
    requiredWhen: (rules) => rules.paymentConfirmationEnabled,
  },
};

/** Las diez plantillas que se piden a Meta: cinco avisos con y sin botón. */
export const WHATSAPP_CURRENT_TEMPLATE_KEYS: WhatsAppTemplateKey[] = Object.values(
  WHATSAPP_NOTIFICATION_CATEGORIES
).flatMap((category) => [category.buttonKey, category.noButtonKey]);

/** Todas las claves conocidas: primero las actuales y al final las anteriores. */
export const WHATSAPP_TEMPLATE_KEYS: WhatsAppTemplateKey[] = [
  ...WHATSAPP_CURRENT_TEMPLATE_KEYS,
  ...WHATSAPP_LEGACY_TEMPLATE_KEYS,
];

export function isWhatsAppTemplateKey(value: unknown): value is WhatsAppTemplateKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(TEMPLATES, value);
}

/** Categoría a la que pertenece una clave, actual o anterior. */
export function resolveTemplateCategory(key: WhatsAppTemplateKey): WhatsAppNotificationCategory {
  if (key === 'reminder' || key === 'reminderV2' || key === 'reminderV2NoButton') return 'reminder';
  if (key === 'dueDateWarning' || key === 'dueDateWarningV2' || key === 'dueDateWarningV2NoButton') {
    return 'dueDateWarning';
  }
  if (key === 'overdueReminder' || key === 'overdueReminderNoButton') return 'overdueReminder';
  if (key === 'suspensionNotice' || key === 'suspensionNoticeV2' || key === 'suspensionNoticeV2NoButton') {
    return 'suspensionNotice';
  }
  return 'paymentConfirmation';
}

/**
 * La plantilla que de verdad se envía. Prefiere la variante que corresponde al cliente y, si
 * no está aprobada, cae a la variante sin botón (su texto no depende del botón) y por último
 * a la anterior.
 */
export function resolveActiveTemplateKey(
  config: { templates: Partial<Record<WhatsAppTemplateKey, string>> },
  category: WhatsAppNotificationCategory,
  hasClientDni = true
): WhatsAppTemplateKey | undefined {
  const definition = WHATSAPP_NOTIFICATION_CATEGORIES[category];
  const preferred = hasClientDni ? definition.buttonKey : definition.noButtonKey;
  if (config.templates[preferred]) return preferred;
  if (preferred !== definition.noButtonKey && config.templates[definition.noButtonKey]) {
    return definition.noButtonKey;
  }
  if (definition.legacyKey && config.templates[definition.legacyKey]) return definition.legacyKey;
  return undefined;
}

/** El texto y las variables de una plantilla según la cuenta que la envía. */
export function getTemplateText(key: WhatsAppTemplateKey, mode: WhatsAppMode = 'own'): WhatsAppTemplateText {
  const definition = WHATSAPP_TEMPLATE_CATALOG[key];
  return mode === 'platform' ? definition.platform : definition;
}

/** El botón no cambia entre cuentas: apunta al portal del negocio que envía. */
export function getTemplateButton(key: WhatsAppTemplateKey): WhatsAppTemplateButton | undefined {
  return WHATSAPP_TEMPLATE_CATALOG[key].button;
}

/** Base pública del portal. Sin https, Meta no puede revisar el botón. */
export function getPortalBaseUrl(): string | undefined {
  const baseUrl = process.env.PORTAL_BASE_URL?.trim().replace(/\/+$/, '');
  if (!baseUrl) return undefined;
  try {
    return new URL(baseUrl).protocol === 'https:' ? baseUrl : undefined;
  } catch {
    return undefined;
  }
}

/** `https://arsystem.org/consulta/{{8}}` para la variable de botón de esa plantilla. */
export function resolveTemplateButtonUrl(key: WhatsAppTemplateKey): string | undefined {
  const baseUrl = getPortalBaseUrl();
  const button = getTemplateButton(key);
  if (!baseUrl || !button) return undefined;
  const variableIndex = getTemplateText(key).variables.indexOf(button.variable) + 1;
  return `${baseUrl}${button.urlTemplate.replace('{{N}}', `{{${variableIndex}}}`)}`;
}

/** Mismo formato que `formatCurrency` del frontend: es-VE, USD, dos decimales. */
export function formatWhatsAppCurrency(amount: number): string {
  return new Intl.NumberFormat('es-VE', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

/** Mismo formato que `formatDate` del frontend: es-MX, mes corto y UTC. */
export function formatWhatsAppDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return new Intl.DateTimeFormat('es-MX', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

export function describeTemplateVariable(variable: WhatsAppTemplateVariable): string {
  return TEMPLATE_VARIABLES[variable].description;
}

export function sampleTemplateVariable(variable: WhatsAppTemplateVariable): string {
  return TEMPLATE_VARIABLES[variable].sample;
}

/** Solo las variables que van dentro del texto; la del botón no se escribe en el cuerpo. */
export function isBodyTemplateVariable(variable: WhatsAppTemplateVariable): boolean {
  return TEMPLATE_VARIABLES[variable].scope !== 'button';
}

export function templateVariableScope(variable: WhatsAppTemplateVariable): 'body' | 'button' {
  return TEMPLATE_VARIABLES[variable].scope === 'button' ? 'button' : 'body';
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
  const definition = WHATSAPP_TEMPLATE_CATALOG[key];
  return Object.fromEntries(
    getTemplateText(key, mode).variables.map((variable, index) => [
      String(index + 1),
      overrides[variable] ?? definition.samples?.[variable] ?? TEMPLATE_VARIABLES[variable].sample,
    ])
  );
}
