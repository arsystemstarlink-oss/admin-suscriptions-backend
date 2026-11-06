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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Duración mínima de un ciclo cobrado completo: la del mes más corto. */
const MIN_BILLING_CYCLE_DAYS = 28;

export const MIN_OVERDUE_PERIODS = 1;
export const MAX_OVERDUE_PERIODS = 3;

export function isValidMaxOverduePeriods(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_OVERDUE_PERIODS &&
    value <= MAX_OVERDUE_PERIODS
  );
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

export function buildClientName(firstName?: string, lastName?: string): string {
  return `${firstName ?? ''} ${lastName ?? ''}`.replace(/\s+/g, ' ').trim();
}

export function buildClientSortName(firstName?: string, lastName?: string): string {
  return buildClientName(firstName, lastName)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function getClientNameUpdateFields(
  current: { clientName?: string; clientSortName?: string },
  expected: { clientName: string; clientSortName: string }
): { clientName?: string; clientSortName?: string } | undefined {
  const updates: { clientName?: string; clientSortName?: string } = {};
  if (current.clientName !== expected.clientName) {
    updates.clientName = expected.clientName;
  }
  if (current.clientSortName !== expected.clientSortName) {
    updates.clientSortName = expected.clientSortName;
  }
  return Object.keys(updates).length > 0 ? updates : undefined;
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

/**
 * Un período vence al terminar su día de corte (en día UTC, como sus fechas):
 * sigue PENDING durante ese día y pasa a estar vencido desde el día siguiente.
 */
export function isPeriodPastDue(endDate: Date, referenceDate: Date): boolean {
  const referenceDay = Date.UTC(
    referenceDate.getUTCFullYear(),
    referenceDate.getUTCMonth(),
    referenceDate.getUTCDate()
  );
  const dueDay = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), endDate.getUTCDate());
  return referenceDay > dueDay;
}

/**
 * Fin del primer período de una suscripción retroactiva: el primer día de corte posterior
 * a la activación. Como se cobra completo, si duraría menos de MIN_BILLING_CYCLE_DAYS se
 * une al ciclo siguiente en lugar de cobrar un mes por unos pocos días.
 */
export function getFirstBillingPeriodEnd(activationDate: Date, billingDay: number): Date {
  const year = activationDate.getUTCFullYear();
  const month = activationDate.getUTCMonth();
  const day = activationDate.getUTCDate();

  const firstMonth = Date.UTC(year, month, billingDay) <= Date.UTC(year, month, day) ? month + 1 : month;
  const end = new Date(Date.UTC(year, firstMonth, billingDay));
  const durationDays = (end.getTime() - activationDate.getTime()) / MS_PER_DAY;
  return durationDays < MIN_BILLING_CYCLE_DAYS
    ? new Date(Date.UTC(year, firstMonth + 1, billingDay))
    : end;
}

/**
 * ID determinista de un período: una suscripción no puede tener dos períodos que empiecen
 * el mismo día, aunque dos procesos intenten crearlos a la vez.
 */
export function buildBillingPeriodId(subscriptionId: string, startDate: Date): string {
  return `period_${subscriptionId}_${startDate.toISOString().slice(0, 10)}`;
}

/**
 * Fin de un ciclo mensual anclado al día de corte. Se usa en todos los
 * encadenamientos (siguiente período, adelantos y períodos retroactivos).
 *
 * Si el día de corte cambió, el ciclo de transición nunca dura menos de
 * MIN_BILLING_CYCLE_DAYS: se cobra completo, así que se extiende al corte siguiente
 * en lugar de cobrar un mes por unos pocos días.
 */
export function getNextBillingPeriodEnd(periodStart: Date, billingDay: number): Date {
  const year = periodStart.getUTCFullYear();
  const month = periodStart.getUTCMonth();
  const end = new Date(Date.UTC(year, month + 1, billingDay));
  const durationDays = (end.getTime() - periodStart.getTime()) / MS_PER_DAY;
  return durationDays < MIN_BILLING_CYCLE_DAYS
    ? new Date(Date.UTC(year, month + 2, billingDay))
    : end;
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

/**
 * Ventana inclusiva de 7 días en UTC para "por vencer". Empieza al inicio del día
 * para no excluir vencimientos de hoy por la diferencia horaria con endDate.
 */
export function getExpiringWindow(now: Date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 7);
  return { start, end };
}

export function isValidDateString(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  // Date.UTC desborda fechas inexistentes (31 de febrero pasa a marzo): debe conservar el texto.
  const date = parseDateOnly(dateStr);
  return !isNaN(date.getTime()) && date.toISOString().slice(0, 10) === dateStr;
}
