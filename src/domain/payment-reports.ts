import { BusinessError } from './entities';
import { isValidDateString, parseDateOnly } from './business-rules';

const VALID_REPORT_METHODS = ['CASH', 'TRANSFER', 'USDT', 'CARD', 'OTHER'];

export function normalizePhoneDigits(value: string): string {
  const digits = (value || '').replace(/\D/g, '');
  let national = digits;
  if (national.startsWith('58') && national.length > 10) {
    national = national.slice(2);
  } else if (national.startsWith('0')) {
    national = national.slice(1);
  }
  return national.slice(-11);
}

export function phonesMatch(a: string, b: string): boolean {
  const da = normalizePhoneDigits(a);
  const db = normalizePhoneDigits(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const tail = Math.min(da.length, db.length, 10);
  if (tail < 7) return false;
  return da.slice(-tail) === db.slice(-tail);
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
  if (!method || !VALID_REPORT_METHODS.includes(method)) {
    throw new BusinessError('INVALID_PAYMENT_METHOD', 'Método de pago inválido.');
  }
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
