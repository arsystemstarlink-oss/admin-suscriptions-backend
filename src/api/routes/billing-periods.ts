import { Router, Request, Response, NextFunction } from 'express';
import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  clientRepository,
} from '../../infrastructure/repositories';
import { RegisterPaymentDto, UpdateBillingPeriodDto } from '../dto';
import { QueryFilter } from '../../infrastructure/firestore-repository';
import { scheduleStatsRecompute } from '../../infrastructure/stats-service';
import { BillingPeriod, BusinessError } from '../../domain/entities';
import { SubscriptionBusinessService } from '../../domain/subscription-service';
import { applyPeriodPayment, subscriptionTransactions } from '../../infrastructure/billing-transactions';
import { parseDateOnly, isValidDateString } from '../../domain/business-rules';
import { getAuth, requireOrganizationId } from '../middleware/tenant';
import { validatePaymentMethod } from '../../domain/payment-methods';
import { assertPaidAtNotFuture } from '../../domain/payment-date';
import { parseBody, registerPaymentSchema, updateBillingPeriodSchema } from '../validation';

const router = Router();
const businessService = new SubscriptionBusinessService();

async function enrichPeriods(periods: BillingPeriod[], organizationId: string | undefined): Promise<any[]> {
  if (periods.length === 0) {
    return [];
  }

  const subscriptionIds = [...new Set(periods.map((p) => p.subscriptionId))];
  const allSubs = await subscriptionRepository.listByIds(subscriptionIds, organizationId);

  const [allClients, allPlans] = await Promise.all([
    clientRepository.listByIds(allSubs.map((s) => s.clientId), organizationId),
    planRepository.listByIds(allSubs.map((s) => s.planId), organizationId),
  ]);

  const subsById = new Map<string, any>();
  for (const sub of allSubs) {
    subsById.set(sub.id, sub);
  }

  const clientsById = new Map<string, any>();
  for (const client of allClients) {
    clientsById.set(client.id, client);
  }

  const plansById = new Map<string, any>();
  for (const plan of allPlans) {
    plansById.set(plan.id, plan);
  }

  return periods.map((period) => {
    const subscription = subsById.get(period.subscriptionId) || null;
    let client = null;
    let plan = null;

    if (subscription) {
      client = clientsById.get(subscription.clientId) || null;
      plan = plansById.get(subscription.planId) || null;
    }

    return {
      ...period,
      subscription: subscription
        ? {
            id: subscription.id,
            kitNumber: subscription.kitNumber,
            status: subscription.status,
          }
        : null,
      client: client
        ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
        : null,
      plan: plan ? { id: plan.id, name: plan.name, price: plan.price } : null,
    };
  });
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const subscriptionId = req.query.subscriptionId as string;
    const clientId = req.query.clientId as string;
    const status = req.query.status as string;
    const search = req.query.search as string;
    const expiresBefore = req.query.expiresBefore as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const cursor = req.query.cursor as string | undefined;
    const organizationId = requireOrganizationId(req);

    const beforeDate = expiresBefore ? new Date(expiresBefore) : undefined;

    if (search) {
      const [matchedClients, kitMatches] = await Promise.all([
        clientRepository.searchBounded(organizationId, search, 100),
        subscriptionRepository.searchByKitNumberBounded(organizationId, search, 100),
      ]);
      const clientIds = matchedClients.map((c) => c.id);
      const subscriptionIds = new Set<string>(kitMatches.map((sub) => sub.id));
      if (clientIds.length > 0) {
        const clientSubs = await subscriptionRepository.listByClientIds(clientIds, organizationId);
        clientSubs.forEach((sub) => subscriptionIds.add(sub.id));
      }
      let periods = subscriptionIds.size
        ? await billingPeriodRepository.listBySubscriptionIds([...subscriptionIds], organizationId)
        : [];
      if (subscriptionId) periods = periods.filter((p) => p.subscriptionId === subscriptionId);
      if (clientId) periods = periods.filter((p) => (p as any).clientId === clientId);
      if (status) periods = periods.filter((p) => p.status === status);
      if (beforeDate && !isNaN(beforeDate.getTime())) {
        periods = periods.filter((p) => p.endDate <= beforeDate);
      }
      const enriched = await enrichPeriods(periods, organizationId);
      const sorted = enriched.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
      const total = sorted.length;
      const paginated = sorted.slice(offset, offset + limit);
      return res.json({
        periods: paginated,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    }

    const filters: QueryFilter[] = [];
    if (subscriptionId) filters.push(['subscriptionId', '==', subscriptionId]);
    if (clientId) filters.push(['clientId', '==', clientId]);
    if (status) filters.push(['status', '==', status]);
    if (beforeDate && !isNaN(beforeDate.getTime())) filters.push(['endDate', '<=', beforeDate]);

    const page = await billingPeriodRepository.listPage({
      organizationId,
      filters,
      limit,
      offset,
      cursor,
      orderBy: beforeDate && !isNaN(beforeDate.getTime()) ? 'endDate' : 'startDate',
      direction: beforeDate && !isNaN(beforeDate.getTime()) ? 'asc' : 'desc',
      requireTotal: !cursor,
    });
    const enrichedPeriods = await enrichPeriods(page.items, organizationId);

    res.json({
      periods: enrichedPeriods,
      pagination: {
        total: page.total,
        limit,
        offset,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const period = await billingPeriodRepository.getByIdScoped(req.params.id, organizationId);
    if (!period) {
      throw new BusinessError('NOT_FOUND', 'Período no encontrado.');
    }

    const subscription = await subscriptionRepository.getByIdScoped(period.subscriptionId, organizationId);
    let client = null;
    let plan = null;

    if (subscription) {
      client = await clientRepository.getByIdScoped(subscription.clientId, organizationId);
      plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
    }

    res.json({
      ...period,
      subscription: subscription
        ? {
            id: subscription.id,
            kitNumber: subscription.kitNumber,
            status: subscription.status,
          }
        : null,
      client: client
        ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
        : null,
      plan: plan ? { id: plan.id, name: plan.name, price: plan.price } : null,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = parseBody<UpdateBillingPeriodDto>(updateBillingPeriodSchema, req.body);
    const organizationId = requireOrganizationId(req);
    const period = await billingPeriodRepository.getByIdScoped(req.params.id, organizationId);

    if (!period) {
      throw new BusinessError('NOT_FOUND', 'Período no encontrado.');
    }

    if (dto.paymentMethod !== undefined) {
      validatePaymentMethod(dto.paymentMethod);
    }

    let paidAt: Date | undefined;
    if (dto.paidAt !== undefined) {
      if (!isValidDateString(dto.paidAt)) {
        throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${dto.paidAt}. Use formato YYYY-MM-DD.`);
      }
      paidAt = parseDateOnly(dto.paidAt);
      assertPaidAtNotFuture(paidAt);
    }

    const updatedPeriod = businessService.updateBillingPeriodPaymentData({
      billingPeriod: period,
      paymentMethod: dto.paymentMethod,
      amount: dto.amount,
      paidAt,
      notes: dto.notes,
    });

    await billingPeriodRepository.update(updatedPeriod);
    scheduleStatsRecompute(organizationId);

    const subscription = await subscriptionRepository.getByIdScoped(updatedPeriod.subscriptionId, organizationId);
    let client = null;
    let plan = null;

    if (subscription) {
      client = await clientRepository.getByIdScoped(subscription.clientId, organizationId);
      plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
    }

    res.json({
      ...updatedPeriod,
      subscription: subscription
        ? {
            id: subscription.id,
            kitNumber: subscription.kitNumber,
            status: subscription.status,
          }
        : null,
      client: client
        ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
        : null,
      plan: plan ? { id: plan.id, name: plan.name, price: plan.price } : null,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto = parseBody<RegisterPaymentDto>(registerPaymentSchema, req.body);
    const auth = getAuth(req);
    const organizationId = requireOrganizationId(req);
    const period = await billingPeriodRepository.getByIdScoped(req.params.id, organizationId);

    if (!period) {
      throw new BusinessError('NOT_FOUND', 'Período no encontrado.');
    }

    if (!dto.paymentMethod || dto.amount === undefined || !dto.paidAt) {
      throw new BusinessError('INVALID_DATA', 'Método de pago, monto y fecha son obligatorios.');
    }

    validatePaymentMethod(dto.paymentMethod);

    if (!isValidDateString(dto.paidAt)) {
      throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${dto.paidAt}. Use formato YYYY-MM-DD.`);
    }

    const paidAt = parseDateOnly(dto.paidAt);
    assertPaidAtNotFuture(paidAt);

    const payment = await subscriptionTransactions.run(
      period.subscriptionId,
      organizationId,
      async (transaction) => {
        const currentPeriod = transaction.periods.find((item) => item.id === period.id);
        if (!currentPeriod) {
          throw new BusinessError('NOT_FOUND', 'Período no encontrado.');
        }
        return applyPeriodPayment(transaction, {
          period: currentPeriod,
          paymentMethod: dto.paymentMethod,
          amount: dto.amount,
          paidAt,
          notes: dto.notes,
          actorUserId: auth.userId,
        });
      }
    );
    scheduleStatsRecompute(organizationId);

    res.json({
      billingPeriod: payment.billingPeriod,
      currentPeriod: payment.currentPeriod,
      subscription: payment.subscription
        ? {
            id: payment.subscription.id,
            status: payment.subscription.status,
            previousStatus: payment.previousStatus,
            reactivated: payment.previousStatus === 'SUSPENDED' && payment.subscription.status === 'ACTIVE',
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
