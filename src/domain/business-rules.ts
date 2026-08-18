import { BillingPeriodStatus, SubscriptionStatus } from './entities';

export const MONTH_NAMES_ES = [
  'Enero',
  'Febrero',
  'Marzo',
  'Abril',
  'Mayo',
  'Junio',
  'Julio',
  'Agosto',
  'Septiembre',
  'Octubre',
  'Noviembre',
  'Diciembre',
];

export function isValidBillingDay(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 28;
}

export function isValidSubscriptionStatus(value: string): value is SubscriptionStatus {
  return value === 'ACTIVE' || value === 'SUSPENDED';
}

export function isValidBillingPeriodStatus(value: string): value is BillingPeriodStatus {
  return value === 'PENDING' || value === 'PAID' || value === 'OVERDUE';
}

export function normalizeDni(raw: string): string {
  const cleaned = raw.trim().toUpperCase().replace(/[^VJ0-9-]/g, '');
  const prefix = cleaned.match(/[VJ]/)?.[0] ?? '';
  const digits = cleaned.replace(/[^0-9]/g, '');
  if (!digits) return '';
  return prefix ? `${prefix}-${digits}` : digits;
}

export function isValidDni(dni: string): boolean {
  return /^[VJ]-\d{7,9}$/.test(dni);
}

export function createId(): string {
  return `id_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

function formatMonthName(date: Date): string {
  return MONTH_NAMES_ES[date.getUTCMonth()];
}

export function buildPeriodLabel(startDate: Date, endDate: Date): string {
  return `${formatMonthName(startDate)} - ${formatMonthName(endDate)}`;
}

export function getBillingPeriodRange(referenceDate: Date, billingDay: number) {
  const year = referenceDate.getUTCFullYear();
  const month = referenceDate.getUTCMonth();
  const day = referenceDate.getUTCDate();

  let startYear = year;
  let startMonth = month;

  if (day < billingDay) {
    startMonth = month - 1;
    if (startMonth < 0) {
      startMonth = 11;
      startYear = year - 1;
    }
  }

  const startDate = new Date(Date.UTC(startYear, startMonth, billingDay));
  const endDate = new Date(Date.UTC(startYear, startMonth + 1, billingDay));

  return {
    startDate,
    endDate,
    periodLabel: buildPeriodLabel(startDate, endDate),
  };
}

export function isDateAfter(date: Date, compareTo: Date): boolean {
  return date.getTime() > compareTo.getTime();
}

export function areSameDay(dateA: Date, dateB: Date): boolean {
  return (
    dateA.getUTCFullYear() === dateB.getUTCFullYear() &&
    dateA.getUTCMonth() === dateB.getUTCMonth() &&
    dateA.getUTCDate() === dateB.getUTCDate()
  );
}

export function parseDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

export function isValidDateString(dateStr: string): boolean {
  const date = parseDateOnly(dateStr);
  return !isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}
