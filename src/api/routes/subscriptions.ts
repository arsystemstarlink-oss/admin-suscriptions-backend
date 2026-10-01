import { Router, Request, Response, NextFunction } from 'express';
import {
  subscriptionRepository,
  clientRepository,
  planRepository,
  billingPeriodRepository,
  domainEventRepository,
} from '../../infrastructure/repositories';
import { CreateSubscriptionDto, UpdateSubscriptionDto } from '../dto';
import { BusinessError, Subscription } from '../../domain/entities';
import { SubscriptionBusinessService, HistoricalPaymentInput } from '../../domain/subscription-service';
import { buildSubscriptionRadarFields } from '../../infrastructure/subscription-radar';
import { parseDateOnly, isValidDateString, createId } from '../../domain/business-rules';
import { getAuth, getEffectiveOrganizationId, resolveCreateOrganizationId, assertResourceInScope } from '../middleware/tenant';
import { isSuperAdmin } from '../../domain/auth-context';

const router = Router();
const businessService = new SubscriptionBusinessService();

async function enrichSubscriptions(subscriptions: Subscription[], organizationId: string | undefined): Promise<any[]> {
  if (subscriptions.length === 0) {
    return [];
  }

  const clientIds = [...new Set(subscriptions.map((s) => s.clientId))];
  const planIds = [...new Set(subscriptions.map((s) => s.planId))];
  const subscriptionIds = subscriptions.map((s) => s.id);

  const [foundClients, foundPlans, allPeriods] = await Promise.all([
    clientRepository.listByIds(clientIds),
    planRepository.listByIds(planIds),
    billingPeriodRepository.listBySubscriptionIds(subscriptionIds, organizationId),
  ]);

  const clientsById = new Map<string, any>();
  for (const client of foundClients) {
    clientsById.set(client.id, client);
  }

  const plansById = new Map<string, any>();
  for (const plan of foundPlans) {
    plansById.set(plan.id, plan);
  }

  const periodsBySubscriptionId = new Map<string, any[]>();
  for (const period of allPeriods) {
    const list = periodsBySubscriptionId.get(period.subscriptionId) || [];
    list.push(period);
    periodsBySubscriptionId.set(period.subscriptionId, list);
  }

  return subscriptions.map((sub) => {
    const client = clientsById.get(sub.clientId) || null;
    const plan = plansById.get(sub.planId) || null;
    const periods = (periodsBySubscriptionId.get(sub.id) || []).slice();

    const currentPeriod = periods.sort(
      (a, b) => b.startDate.getTime() - a.startDate.getTime()
    )[0];

    const overduePeriods = periods.filter((p) => p.status === 'OVERDUE');
    const pendingPeriods = periods.filter((p) => p.status === 'PENDING');
    const hasDebt = overduePeriods.length > 0;

    const nearestPendingDate = pendingPeriods.reduce<Date | undefined>(
      (nearest, period) =>
        !nearest || period.endDate.getTime() < nearest.getTime() ? period.endDate : nearest,
      undefined
    );

    const closestOverdueDate = overduePeriods.reduce<Date | undefined>(
      (closest, period) =>
        !closest || period.endDate.getTime() > closest.getTime() ? period.endDate : closest,
      undefined
    );

    return {
      ...sub,
      client: client
        ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
        : null,
      plan: plan ? { id: plan.id, name: plan.name, price: plan.price } : null,
      currentPeriod,
      totalPeriods: periods.length,
      overduePeriods: overduePeriods.length,
      pendingPeriods: pendingPeriods.length,
      hasDebt,
      nearestPendingDate,
      closestOverdueDate,
    };
  });
}

function radarRank(subscription: any): number {
  if ((subscription.pendingPeriods ?? 0) > 0) return 1;
  if (subscription.hasDebt) return 2;
  return 3;
}

function toTime(value?: Date | string | null): number | undefined {
  if (!value) return undefined;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? undefined : time;
}

function compareSubscriptionsForRadar(a: any, b: any): number {
  const rankA = radarRank(a);
  const rankB = radarRank(b);
  if (rankA !== rankB) return rankA - rankB;

  if (rankA === 1) {
    const aDate = toTime(a.nearestPendingDate);
    const bDate = toTime(b.nearestPendingDate);
    if (aDate !== undefined && bDate !== undefined && aDate !== bDate) return aDate - bDate;
    if (aDate === undefined && bDate !== undefined) return 1;
    if (bDate === undefined && aDate !== undefined) return -1;
  } else if (rankA === 2) {
    const aDate = toTime(a.closestOverdueDate);
    const bDate = toTime(b.closestOverdueDate);
    if (aDate !== undefined && bDate !== undefined && aDate !== bDate) return bDate - aDate;
    if (aDate === undefined && bDate !== undefined) return 1;
    if (bDate === undefined && aDate !== undefined) return -1;
  }

  return (toTime(b.createdAt) ?? 0) - (toTime(a.createdAt) ?? 0);
}

async function enrichRadarSubscriptions(subscriptions: Subscription[]): Promise<any[]> {
  if (subscriptions.length === 0) {
    return [];
  }

  const clientIds = [...new Set(subscriptions.map((s) => s.clientId))];
  const planIds = [...new Set(subscriptions.map((s) => s.planId))];

  const [foundClients, foundPlans] = await Promise.all([
    clientRepository.listByIds(clientIds),
    planRepository.listByIds(planIds),
  ]);

  const clientsById = new Map<string, any>();
  for (const client of foundClients) {
    clientsById.set(client.id, client);
  }

  const plansById = new Map<string, any>();
  for (const plan of foundPlans) {
    plansById.set(plan.id, plan);
  }

  return subscriptions.map((sub) => {
    const client = clientsById.get(sub.clientId) || null;
    const plan = plansById.get(sub.planId) || null;

    const currentPeriod =
      sub.currentPeriodId && sub.currentPeriodStartDate && sub.currentPeriodEndDate
        ? {
            id: sub.currentPeriodId,
            organizationId: sub.organizationId,
            subscriptionId: sub.id,
            periodLabel: '',
            startDate: sub.currentPeriodStartDate,
            endDate: sub.currentPeriodEndDate,
            amount: sub.currentPeriodAmount ?? 0,
            status: sub.currentPeriodStatus,
            createdAt: sub.currentPeriodStartDate,
          }
        : undefined;

    return {
      ...sub,
      client: client
        ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
        : null,
      plan: plan ? { id: plan.id, name: plan.name, price: plan.price } : null,
      currentPeriod,
      totalPeriods: sub.totalPeriods ?? 0,
      overduePeriods: sub.overduePeriods ?? 0,
      pendingPeriods: sub.pendingPeriods ?? 0,
      hasDebt: sub.hasDebt ?? false,
    };
  });
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreateSubscriptionDto = req.body;
    const auth = getAuth(req);
    const organizationId = resolveCreateOrganizationId(req);

    if (!dto.kitNumber || !dto.kitNumber.trim()) {
      throw new BusinessError('INVALID_DATA', 'El número de kit es obligatorio.');
    }

    const client = await clientRepository.getByIdScoped(dto.clientId, isSuperAdmin(auth) ? organizationId : auth.organizationId ?? undefined);
    if (!client) {
      throw new BusinessError('CLIENT_NOT_FOUND', 'Cliente no encontrado.');
    }
    assertResourceInScope(client.organizationId, auth, organizationId);

    const plan = await planRepository.getByIdScoped(dto.planId, isSuperAdmin(auth) ? organizationId : auth.organizationId ?? undefined);
    if (!plan) {
      throw new BusinessError('PLAN_NOT_FOUND', 'Plan no encontrado.');
    }
    assertResourceInScope(plan.organizationId, auth, organizationId);

    if (client.organizationId !== plan.organizationId) {
      throw new BusinessError(
        'CROSS_TENANT_REFERENCE',
        'El cliente y el plan deben pertenecer a la misma organización.'
      );
    }

    let activationDate: Date | undefined;
    if (dto.activationDate) {
      activationDate = parseDateOnly(dto.activationDate);
      if (isNaN(activationDate.getTime())) {
        throw new BusinessError('INVALID_ACTIVATION_DATE', 'Fecha de activación inválida.');
      }
    }

    if (dto.historicalPayments && !Array.isArray(dto.historicalPayments)) {
      throw new BusinessError('INVALID_HISTORICAL_PAYMENTS', 'Los pagos históricos deben ser un array.');
    }

    if (dto.historicalPayments && dto.historicalPayments.length > 0 && !activationDate) {
      throw new BusinessError('INVALID_DATA', 'Los pagos históricos requieren una fecha de activación.');
    }

    const historicalPayments: HistoricalPaymentInput[] | undefined = dto.historicalPayments?.map((p) => {
      if (!isValidDateString(p.paidAt)) {
        throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${p.paidAt}. Use formato YYYY-MM-DD.`);
      }
      return {
        periodLabel: p.periodLabel,
        startDate: parseDateOnly(p.startDate),
        endDate: parseDateOnly(p.endDate),
        amount: p.amount,
        paidAt: parseDateOnly(p.paidAt),
        paymentMethod: p.paymentMethod,
        notes: p.notes,
      };
    });

    const { subscription, billingPeriods, summary } = businessService.createSubscription({
      organizationId,
      clientId: dto.clientId,
      plan,
      kitNumber: dto.kitNumber.toUpperCase(),
      accountNumber: dto.accountNumber,
      billingDay: dto.billingDay,
      maxOverduePeriods: dto.maxOverduePeriods,
      registrationDate: new Date(),
      activationDate,
      historicalPayments,
    });

    const scopedPeriods = billingPeriods.map((period) => ({ ...period, organizationId }));
    const scopedSubscription = {
      ...subscription,
      ...buildSubscriptionRadarFields(scopedPeriods),
      organizationId,
      createdByUserId: auth.userId,
      createdByRole: auth.role,
    };

    await subscriptionRepository.create(scopedSubscription);
    for (const period of scopedPeriods) {
      await billingPeriodRepository.create(period);
    }

    try {
      await domainEventRepository.create({
        id: createId(),
        type: 'subscription.created',
        organizationId,
        actorUserId: auth.userId,
        entity: 'subscription',
        entityId: scopedSubscription.id,
        payload: { kitNumber: scopedSubscription.kitNumber, planId: scopedSubscription.planId },
        createdAt: new Date(),
      });
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando subscription.created:', eventError);
    }

    res.status(201).json({
      subscription: scopedSubscription,
      billingPeriods: scopedPeriods,
      summary,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const organizationId = getEffectiveOrganizationId(req);
    const clientId = req.query.clientId as string | undefined;
    const requestedStatus = (req.query.status as string | undefined)?.toUpperCase();
    const status = requestedStatus && requestedStatus !== 'ALL' ? requestedStatus : undefined;
    const search = req.query.search as string | undefined;
    const hasOverduePeriods = req.query.hasOverduePeriods as string | undefined;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const canUseRadarQuery =
      Boolean(organizationId) &&
      (status === 'ACTIVE' || status === 'SUSPENDED') &&
      !clientId &&
      !search &&
      hasOverduePeriods === undefined;

    if (canUseRadarQuery) {
      try {
        const page = await subscriptionRepository.listRadarPage({
          organizationId: organizationId as string,
          status: status as 'ACTIVE' | 'SUSPENDED',
          limit,
          offset,
          requireTotal: true,
        });

        const isBackfilled = page.items.every(
          (sub) => sub.radarRank !== undefined && sub.radarRank !== null
        );

        if (isBackfilled) {
          const enrichedSubscriptions = await enrichRadarSubscriptions(page.items);
          return res.json({
            subscriptions: enrichedSubscriptions,
            pagination: {
              total: page.total ?? enrichedSubscriptions.length,
              limit,
              offset,
              hasMore: page.hasMore,
            },
          });
        }
      } catch (error) {
        console.error('[Subscriptions] Fallback a cálculo en memoria:', error);
      }
    }

    const filters: Array<[string, any]> = [];
    if (organizationId) filters.push(['organizationId', organizationId]);
    if (status) filters.push(['status', status]);

    let subscriptions =
      filters.length > 0
        ? await subscriptionRepository.listByFields(filters)
        : await subscriptionRepository.list();

    if (clientId) {
      if (!isSuperAdmin(auth)) {
        const client = await clientRepository.getByIdScoped(clientId, auth.organizationId ?? undefined);
        if (!client) {
          throw new BusinessError('CLIENT_NOT_FOUND', 'Cliente no encontrado.');
        }
      }
      subscriptions = subscriptions.filter((s) => s.clientId === clientId);
    }

    const enrichedSubscriptions = await enrichSubscriptions(subscriptions, organizationId);

    let filteredSubscriptions = enrichedSubscriptions;

    if (search) {
      const searchLower = search.toLowerCase();
      filteredSubscriptions = filteredSubscriptions.filter(
        (s) =>
          (s.client?.firstName?.toLowerCase().includes(searchLower)) ||
          (s.client?.lastName?.toLowerCase().includes(searchLower)) ||
          (`${s.client?.firstName ?? ''} ${s.client?.lastName ?? ''}`.toLowerCase().includes(searchLower)) ||
          (s.client?.email?.toLowerCase().includes(searchLower)) ||
          (s.client?.phone?.includes(search)) ||
          (s.kitNumber?.toLowerCase().includes(searchLower))
      );
    }

    if (hasOverduePeriods !== undefined) {
      const wantOverdue = hasOverduePeriods === 'true';
      filteredSubscriptions = filteredSubscriptions.filter((s) => s.hasDebt === wantOverdue);
    }

    filteredSubscriptions = [...filteredSubscriptions].sort(compareSubscriptionsForRadar);

    const total = filteredSubscriptions.length;
    const paginatedSubscriptions = filteredSubscriptions.slice(offset, offset + limit);

    res.json({
      subscriptions: paginatedSubscriptions,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const subscription = await subscriptionRepository.getByIdScoped(req.params.id, organizationId);
    if (!subscription) {
      throw new BusinessError('NOT_FOUND', 'Suscripción no encontrada.');
    }

    const [client, plan, periods] = await Promise.all([
      clientRepository.getByIdScoped(subscription.clientId, organizationId),
      planRepository.getByIdScoped(subscription.planId, organizationId),
      billingPeriodRepository.listBySubscriptionId(req.params.id, organizationId),
    ]);

    const sortedPeriods = periods.sort(
      (a, b) => b.startDate.getTime() - a.startDate.getTime()
    );

    res.json({
      subscription: {
        ...subscription,
        client: client
          ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
          : null,
        plan: plan ? { id: plan.id, name: plan.name, price: plan.price, description: plan.description } : null,
      },
      billingPeriods: sortedPeriods,
      summary: {
        totalPeriods: periods.length,
        paidPeriods: periods.filter((p) => p.status === 'PAID').length,
        pendingPeriods: periods.filter((p) => p.status === 'PENDING').length,
        overduePeriods: periods.filter((p) => p.status === 'OVERDUE').length,
        totalPaid: periods
          .filter((p) => p.status === 'PAID')
          .reduce((sum, p) => sum + p.amount, 0),
        totalPending: periods
          .filter((p) => p.status === 'PENDING')
          .reduce((sum, p) => sum + p.amount, 0),
        hasDebt: periods.some((p) => p.status === 'OVERDUE'),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: UpdateSubscriptionDto = req.body;
    const auth = getAuth(req);
    const organizationId = getEffectiveOrganizationId(req);
    const existing = await subscriptionRepository.getByIdScoped(req.params.id, organizationId);

    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Suscripción no encontrada.');
    }

    let updated = { ...existing };

    if (dto.planId && dto.planId !== existing.planId) {
      const newPlan = await planRepository.getByIdScoped(dto.planId, isSuperAdmin(auth) ? organizationId : auth.organizationId ?? undefined);
      if (!newPlan) {
        throw new BusinessError('PLAN_NOT_FOUND', 'Plan no encontrado.');
      }
      assertResourceInScope(newPlan.organizationId, auth, organizationId);
      updated = businessService.changeSubscriptionPlan(updated, newPlan);
    }

    if (dto.kitNumber !== undefined) {
      updated = { ...updated, kitNumber: dto.kitNumber.toUpperCase() };
    }

    if (dto.accountNumber !== undefined) {
      updated = { ...updated, accountNumber: dto.accountNumber };
    }

    if (dto.billingDay !== undefined) {
      updated = { ...updated, billingDay: dto.billingDay };
    }

    if (dto.maxOverduePeriods !== undefined) {
      updated = { ...updated, maxOverduePeriods: dto.maxOverduePeriods };
    }

    if (dto.status !== undefined) {
      updated = { ...updated, status: dto.status };
    }

    businessService.validateSubscription(updated);
    await subscriptionRepository.update(updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const existing = await subscriptionRepository.getByIdScoped(req.params.id, organizationId);
    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Suscripción no encontrada.');
    }

    await billingPeriodRepository.deleteBySubscriptionId(req.params.id, organizationId);
    await subscriptionRepository.delete(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
