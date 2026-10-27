import { BusinessError } from './entities';

/** Métodos aceptados en cualquier escritura de cobro o reporte. */
export const PAYMENT_METHODS = ['CASH', 'TRANSFER', 'USDT', 'CARD', 'OTHER'] as const;

/** Valor legacy: solo se acepta al leer datos existentes, nunca al escribir. */
export const LEGACY_PAYMENT_METHODS = ['INITIAL_PAYMENT'] as const;

export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export function isPaymentMethod(value: unknown): value is PaymentMethod {
  return typeof value === 'string' && (PAYMENT_METHODS as readonly string[]).includes(value);
}

export function validatePaymentMethod(value: unknown): asserts value is PaymentMethod {
  if (!isPaymentMethod(value)) {
    throw new BusinessError('INVALID_PAYMENT_METHOD', 'Método de pago inválido.');
  }
}
