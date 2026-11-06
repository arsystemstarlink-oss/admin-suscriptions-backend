import { z } from 'zod';
import { BusinessError } from '../domain/entities';

/**
 * Validación de la forma de las peticiones: tipos y longitudes. Las reglas de negocio
 * (día de corte, fechas, montos exactos) se validan en el dominio con sus propios códigos.
 */
const text = (maxLength: number) => z.string().max(maxLength);
const optionalText = (maxLength: number) => text(maxLength).nullish();
const requiredId = z.string().trim().min(1).max(200);
const amount = z.number().finite();

export const createClientSchema = z.object({
  firstName: text(100).optional(),
  lastName: text(100).optional(),
  phone: text(40).optional(),
  dni: optionalText(20),
  email: optionalText(200),
  address: optionalText(500),
  notes: optionalText(1000),
});

export const updateClientSchema = createClientSchema;

export const createPlanSchema = z.object({
  name: text(200).optional(),
  price: amount.optional(),
  description: optionalText(1000),
  active: z.boolean().optional(),
});

export const updatePlanSchema = createPlanSchema;

const historicalPaymentSchema = z.object({
  periodLabel: text(100),
  startDate: text(10),
  endDate: text(10),
  amount,
  paidAt: text(10),
  paymentMethod: text(40),
  notes: optionalText(1000),
});

export const createSubscriptionSchema = z.object({
  clientId: requiredId,
  planId: requiredId,
  kitNumber: text(100).optional(),
  accountNumber: optionalText(100),
  billingDay: z.number().optional(),
  maxOverduePeriods: z.number().optional(),
  activationDate: optionalText(10),
  historicalPayments: z.array(historicalPaymentSchema).max(120).optional(),
});

export const updateSubscriptionSchema = z.object({
  planId: requiredId.optional(),
  kitNumber: z.string().trim().min(1).max(100).optional(),
  accountNumber: optionalText(100),
  billingDay: z.number().optional(),
  maxOverduePeriods: z.number().optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED']).optional(),
});

export const registerPaymentSchema = z.object({
  paymentMethod: text(40).optional(),
  amount: amount.optional(),
  paidAt: text(10).optional(),
  notes: optionalText(1000),
});

export const updateBillingPeriodSchema = registerPaymentSchema;

export const registerAdvancePaymentSchema = z.object({
  paymentMethod: text(40).optional(),
  paidAt: text(10).optional(),
  notes: optionalText(1000),
  anchorPeriodId: requiredId.optional(),
});

/** Límite y desplazamiento acotados: un valor negativo o excesivo no llega a Firestore. */
export function parsePagination(
  query: { limit?: unknown; offset?: unknown },
  options: { defaultLimit?: number; maxLimit?: number } = {}
): { limit: number; offset: number } {
  const { defaultLimit = 50, maxLimit = 200 } = options;
  const limit = parseInt(String(query.limit), 10) || defaultLimit;
  const offset = parseInt(String(query.offset), 10) || 0;
  return { limit: Math.min(Math.max(limit, 1), maxLimit), offset: Math.max(offset, 0) };
}

/** Los campos faltantes siguen dando el error específico de cada ruta o del dominio. */
export function parseBody<T>(schema: z.ZodType, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.join('.') || 'body';
    throw new BusinessError('INVALID_DATA', `El campo "${field}" no es válido.`);
  }
  return result.data as T;
}
