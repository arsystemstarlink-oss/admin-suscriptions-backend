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

export function createId(): string {
  return `id_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

function formatMonthName(date: Date): string {
  return MONTH_NAMES_ES[date.getMonth()];
}

export function buildPeriodLabel(startDate: Date, endDate: Date): string {
  return `${formatMonthName(startDate)} - ${formatMonthName(endDate)}`;
}

export function getBillingPeriodRange(referenceDate: Date, billingDay: number) {
  const year = referenceDate.getFullYear();
  const month = referenceDate.getMonth();
  const day = referenceDate.getDate();

  let startYear = year;
  let startMonth = month;

  if (day < billingDay) {
    startMonth = month - 1;
    if (startMonth < 0) {
      startMonth = 11;
      startYear = year - 1;
    }
  }

  const startDate = new Date(startYear, startMonth, billingDay, 0, 0, 0, 0);
  const endDate = new Date(startDate);
  endDate.setMonth(endDate.getMonth() + 1);

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
    dateA.getFullYear() === dateB.getFullYear() &&
    dateA.getMonth() === dateB.getMonth() &&
    dateA.getDate() === dateB.getDate()
  );
}

export function parseDateOnly(dateStr: string): Date {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function isValidDateString(dateStr: string): boolean {
  const date = parseDateOnly(dateStr);
  return !isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(dateStr);
}
