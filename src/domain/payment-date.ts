import { BusinessError } from './entities';

const DATE_ONLY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normaliza una fecha de pago de negocio. Acepta `YYYY-MM-DD` (se interpreta
 * al mediodía UTC para evitar desfases) o una fecha ISO completa. Rechaza
 * fechas futuras con el mismo criterio en todos los flujos, salvo que se pida
 * explícitamente una cotización (`allowFuture`).
 */
export function parseBusinessPaymentDate(
  value: unknown,
  now = new Date(),
  options: { allowFuture?: boolean } = {}
): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago es obligatoria.');
  }

  const raw = value.trim();
  const parsed = new Date(DATE_ONLY_REGEX.test(raw) ? `${raw}T12:00:00.000Z` : raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago es inválida.');
  }

  if (options.allowFuture) {
    return parsed;
  }

  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (parsed.getTime() >= tomorrow) {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago no puede ser futura.');
  }

  return parsed;
}
