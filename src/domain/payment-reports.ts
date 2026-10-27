import { BusinessError } from './entities';
import { isValidDateString, parseDateOnly } from './business-rules';
import { normalizeVenezuelanPhoneDigits } from './phone';
import { validatePaymentMethod } from './payment-methods';

export { phonesMatch } from './phone';

export function normalizePhoneDigits(value: string): string {
  return normalizeVenezuelanPhoneDigits(value);
}

export function maskPhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length <= 4) return '••••';
  return `••••${digits.slice(-4)}`;
}

export function maskEmail(email?: string): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split('@');
  if (!domain) return '•••';
  const head = (local || '').slice(0, 1) || '•';
  return `${head}•••@${domain}`;
}

export function validateReportPaymentMethod(method: string): void {
  validatePaymentMethod(method);
}

export function validateReportPaidAt(paidAt: string, periodStartDate: Date): Date {
  if (!isValidDateString(paidAt)) {
    throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${paidAt}. Use formato YYYY-MM-DD.`);
  }
  const parsed = parseDateOnly(paidAt);
  const startDay = new Date(Date.UTC(periodStartDate.getUTCFullYear(), periodStartDate.getUTCMonth(), periodStartDate.getUTCDate()));
  if (parsed.getTime() < startDay.getTime()) {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago no puede ser anterior al inicio del período.');
  }
  const today = new Date();
  const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
  if (parsed.getTime() > todayUtc.getTime()) {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago no puede ser futura.');
  }
  return parsed;
}
