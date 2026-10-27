import { BusinessError } from './entities';
import { normalizePhoneToE164 } from './phone';
import { EMAIL_REGEX, validatePasswordStrength } from './validation';

export type PublicSignupPlan = 'basico' | 'pro' | 'negocio';
export type PublicSignupPaymentMethod = 'transferencia' | 'usdt';

export interface PublicSignupPaymentInput {
  method: PublicSignupPaymentMethod;
  reference: string;
  notes?: string;
}

export interface PublicSignupInput {
  plan: PublicSignupPlan;
  organizationName: string;
  adminName: string;
  email: string;
  password: string;
  phone?: string;
  payment?: PublicSignupPaymentInput;
  turnstileToken?: string;
}

export interface PlanQuoteInput {
  name: string;
  email: string;
  phone?: string;
  organizationName?: string;
  estimatedClients: number;
  message?: string;
  turnstileToken?: string;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  const normalized = text(value);
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

export function parsePublicSignupPlan(value: unknown): PublicSignupPlan {
  if (value === 'basico' || value === 'pro' || value === 'negocio') {
    return value;
  }
  if (value === 'a-medida') {
    throw new BusinessError(
      'INVALID_DATA',
      'El plan A medida se cotiza con una solicitud, no con el alta autoservicio.',
    );
  }
  throw new BusinessError('INVALID_DATA', 'El plan seleccionado no es válido.');
}

/**
 * Normaliza y valida el alta autoservicio. No confía en montos, fechas ni
 * límites enviados por el cliente: solo acepta los campos del formulario.
 */
export function validatePublicSignupInput(body: unknown): PublicSignupInput {
  const source = (body ?? {}) as Record<string, unknown>;
  const organizationInput = (source.organization ?? {}) as Record<string, unknown>;
  const adminInput = (source.admin ?? {}) as Record<string, unknown>;
  const paymentInput = (source.payment ?? {}) as Record<string, unknown>;

  const plan = parsePublicSignupPlan(source.plan);
  const organizationName = text(organizationInput.name);
  const adminName = text(adminInput.name);
  const email = text(adminInput.email).toLowerCase();
  const password = typeof adminInput.password === 'string' ? adminInput.password : '';

  if (!organizationName) {
    throw new BusinessError('INVALID_DATA', 'El nombre de la organización es obligatorio.');
  }
  if (organizationName.length > 120) {
    throw new BusinessError('INVALID_DATA', 'El nombre de la organización es demasiado largo.');
  }
  if (!adminName) {
    throw new BusinessError('INVALID_DATA', 'El nombre del administrador es obligatorio.');
  }
  if (adminName.length > 120) {
    throw new BusinessError('INVALID_DATA', 'El nombre del administrador es demasiado largo.');
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new BusinessError('INVALID_EMAIL', 'El email no es válido.');
  }
  if (!password) {
    throw new BusinessError('INVALID_DATA', 'La contraseña es obligatoria.');
  }
  validatePasswordStrength(password);

  const phoneRaw = text(adminInput.phone);

  let payment: PublicSignupPaymentInput | undefined;
  if (plan !== 'basico') {
    const method = paymentInput.method;
    if (method !== 'transferencia' && method !== 'usdt') {
      throw new BusinessError(
        'INVALID_PAYMENT_METHOD',
        'El método de pago debe ser transferencia o USDT.',
      );
    }
    const reference = text(paymentInput.reference);
    if (!reference) {
      throw new BusinessError('INVALID_DATA', 'La referencia o hash del pago es obligatorio.');
    }
    payment = {
      method,
      reference: reference.slice(0, 120),
      notes: optionalText(paymentInput.notes, 500),
    };
  }

  return {
    plan,
    organizationName,
    adminName,
    email,
    password,
    phone: phoneRaw ? normalizePhoneToE164(phoneRaw) : undefined,
    payment,
    turnstileToken: optionalText(source.turnstileToken, 4096),
  };
}

export function validatePlanQuoteInput(body: unknown): PlanQuoteInput {
  const source = (body ?? {}) as Record<string, unknown>;
  const name = text(source.name);
  const email = text(source.email).toLowerCase();
  const phoneRaw = text(source.phone);

  if (!name) {
    throw new BusinessError('INVALID_DATA', 'El nombre es obligatorio.');
  }
  if (name.length > 120) {
    throw new BusinessError('INVALID_DATA', 'El nombre es demasiado largo.');
  }
  if (!EMAIL_REGEX.test(email)) {
    throw new BusinessError('INVALID_EMAIL', 'El email no es válido.');
  }

  const estimatedClients =
    typeof source.estimatedClients === 'number'
      ? source.estimatedClients
      : Number(source.estimatedClients);
  if (!Number.isInteger(estimatedClients) || estimatedClients <= 0) {
    throw new BusinessError(
      'INVALID_DATA',
      'La cantidad estimada de clientes debe ser un entero mayor que cero.',
    );
  }

  return {
    name,
    email,
    phone: phoneRaw ? normalizePhoneToE164(phoneRaw) : undefined,
    organizationName: optionalText(source.organizationName, 120),
    estimatedClients,
    message: optionalText(source.message, 1000),
    turnstileToken: optionalText(source.turnstileToken, 4096),
  };
}

export interface PublicBankTransferInstructions {
  bankName: string;
  accountHolder: string;
  accountNumber: string;
  accountType: string;
  rif: string;
  notes?: string;
}

export interface PublicUsdtInstructions {
  network: string;
  address: string;
  notes?: string;
}

export interface PublicPaymentInstructions {
  bankTransfer: PublicBankTransferInstructions | null;
  usdt: PublicUsdtInstructions | null;
}

/** Datos públicos de pago leídos del entorno; un bloque es null si está incompleto. */
export function buildPaymentInstructions(
  env: NodeJS.ProcessEnv = process.env,
): PublicPaymentInstructions {
  const envText = (key: string): string => (env[key] ?? '').trim();

  const bankValues = {
    bankName: envText('PAYMENT_BANK_NAME'),
    accountHolder: envText('PAYMENT_BANK_ACCOUNT_HOLDER'),
    accountNumber: envText('PAYMENT_BANK_ACCOUNT_NUMBER'),
    accountType: envText('PAYMENT_BANK_ACCOUNT_TYPE'),
    rif: envText('PAYMENT_BANK_RIF'),
  };
  const bankTransfer = Object.values(bankValues).every(Boolean)
    ? {
        ...bankValues,
        notes: envText('PAYMENT_BANK_NOTES') || undefined,
      }
    : null;

  const network = envText('PAYMENT_USDT_NETWORK');
  const address = envText('PAYMENT_USDT_ADDRESS');
  const usdt =
    network && address
      ? {
          network,
          address,
          notes: envText('PAYMENT_USDT_NOTES') || undefined,
        }
      : null;

  return { bankTransfer, usdt };
}
