import { Router, Request, Response, NextFunction } from 'express';
import {
  subscriptionRepository,
  clientRepository,
  planRepository,
  billingPeriodRepository,
  domainEventRepository,
} from '../../infrastructure/repositories';
import { CreateSubscriptionDto, RegisterAdvancePaymentDto, UpdateSubscriptionDto } from '../dto';
import { BusinessError, Subscription } from '../../domain/entities';
import { SubscriptionBusinessService, HistoricalPaymentInput } from '../../domain/subscription-service';
import { applyRadarToSubscription, buildSubscriptionRadarFields } from '../../infrastructure/subscription-radar';
import { parseDateOnly, isValidDateString, createId } from '../../domain/business-rules';
import { validateReportPaymentMethod } from '../../domain/payment-reports';
import { getAuth, requireOrganizationId, resolveCreateOrganizationId, assertResourceInScope } from '../middleware/tenant';
import { isSuperAdmin } from '../../domain/auth-context';
import { getFirestore } from '../../infrastructure/firebase';
import { stripUndefined } from '../../infrastructure/serialization';
import { scheduleStatsRecompute } from '../../infrastructure/stats-service';

const router = Router();
const businessService = new SubscriptionBusinessService();

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

async function enrichRadarSubscriptions(
  subscriptions: Subscription[],
  organizationId?: string
): Promise<any[]> {
  if (subscriptions.length === 0) {
    return [];
  }

  const clientIds = [...new Set(subscriptions.map((s) => s.clientId))];
  const planIds = [...new Set(subscriptions.map((s) => s.planId))];

  const [foundClients, foundPlans] = await Promise.all([
    clientRepository.listByIds(clientIds, organizationId),
    planRepository.listByIds(planIds, organizationId),
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

    const db = getFirestore();
    const batch = db.batch();
    batch.set(
      db.collection('subscriptions').doc(scopedSubscription.id),
      stripUndefined(scopedSubscription)
    );
    for (const period of scopedPeriods) {
      batch.set(db.collection('billingPeriods').doc(period.id), stripUndefined(period));
    }

    try {
      const eventId = createId();
      batch.set(
        db.collection('domainEvents').doc(eventId),
        stripUndefined({
          id: eventId,
          type: 'subscription.created',
          organizationId,
          actorUserId: auth.userId,
          entity: 'subscription',
          entityId: scopedSubscription.id,
          payload: { kitNumber: scopedSubscription.kitNumber, planId: scopedSubscription.planId },
          createdAt: new Date(),
        })
      );
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando subscription.created:', eventError);
    }

    await batch.commit();
    scheduleStatsRecompute(organizationId);

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
    const organizationId = requireOrganizationId(req);
    const clientId = req.query.clientId as string | undefined;
    const requestedStatus = (req.query.status as string | undefined)?.toUpperCase();
    const status = requestedStatus && requestedStatus !== 'ALL' ? requestedStatus : undefined;
    const search = req.query.search as string | undefined;
    const hasOverduePeriods = req.query.hasOverduePeriods as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const cursor = req.query.cursor as string | undefined;

    const parsedStatus = status === 'ACTIVE' || status === 'SUSPENDED' ? status : undefined;
    const parsedHasDebt =
      hasOverduePeriods !== undefined ? hasOverduePeriods === 'true' : undefined;

    if (search) {
      const [matchedClients, kitMatches] = await Promise.all([
        clientRepository.searchBounded(organizationId, search, 100),
        subscriptionRepository.searchByKitNumberBounded(organizationId, search, 100),
      ]);
      const clientIds = matchedClients.map((c) => c.id);
      const found = clientIds.length
        ? await subscriptionRepository.listByClientIds(clientIds, organizationId)
        : [];
      const byId = new Map(found.map((sub) => [sub.id, sub]));
      kitMatches.forEach((sub) => byId.set(sub.id, sub));

      let subscriptions = [...byId.values()];
      if (clientId) subscriptions = subscriptions.filter((sub) => sub.clientId === clientId);
      if (parsedStatus) subscriptions = subscriptions.filter((sub) => sub.status === parsedStatus);
      if (parsedHasDebt !== undefined) {
        subscriptions = subscriptions.filter((sub) => (sub.hasDebt ?? false) === parsedHasDebt);
      }

      const enriched = await enrichRadarSubscriptions(subscriptions, organizationId);
      const sorted = [...enriched].sort(compareSubscriptionsForRadar);
      const total = sorted.length;
      const paginated = sorted.slice(offset, offset + limit);
      return res.json({
        subscriptions: paginated,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    }

    const page = await subscriptionRepository.listRadarPage({
      organizationId,
      status: parsedStatus,
      clientId,
      hasDebt: parsedHasDebt,
      limit,
      offset,
      cursor,
      requireTotal: !cursor,
    });

    const missingRadar = page.items.filter(
      (sub) => sub.radarRank === undefined || sub.radarRank === null
    );
    if (missingRadar.length > 0) {
      console.error(
        '[Subscriptions] Suscripciones sin campos radar (requieren backfill):',
        missingRadar.map((sub) => sub.id)
      );
    }

    const enrichedSubscriptions = await enrichRadarSubscriptions(page.items, organizationId);
    return res.json({
      subscriptions: enrichedSubscriptions,
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

    const currentPeriod = sortedPeriods[0];
    const overduePeriods = periods.filter((p) => p.status === 'OVERDUE');
    const pendingPeriods = periods.filter((p) => p.status === 'PENDING');

    res.json({
      subscription: {
        ...subscription,
        client: client
          ? { id: client.id, firstName: client.firstName, lastName: client.lastName, phone: client.phone, dni: client.dni, email: client.email }
          : null,
        plan: plan ? { id: plan.id, name: plan.name, price: plan.price, description: plan.description } : null,
        currentPeriod,
        totalPeriods: periods.length,
        overduePeriods: overduePeriods.length,
        pendingPeriods: pendingPeriods.length,
        hasDebt: overduePeriods.length > 0,
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
    const organizationId = requireOrganizationId(req);
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
    scheduleStatsRecompute(organizationId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const existing = await subscriptionRepository.getByIdScoped(req.params.id, organizationId);
    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Suscripción no encontrada.');
    }

    await billingPeriodRepository.deleteBySubscriptionId(req.params.id, organizationId);
    await subscriptionRepository.delete(req.params.id);
    scheduleStatsRecompute(organizationId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/:id/pay-advance', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: RegisterAdvancePaymentDto = req.body;
    const auth = getAuth(req);
    const organizationId = requireOrganizationId(req);
    const subscription = await subscriptionRepository.getByIdScoped(req.params.id, organizationId);

    if (!subscription) {
      throw new BusinessError('NOT_FOUND', 'Suscripción no encontrada.');
    }

    if (subscription.status !== 'ACTIVE') {
      throw new BusinessError('SUBSCRIPTION_SUSPENDED', 'No se puede pagar por adelantado una suscripción suspendida. Cobre los períodos vencidos primero.');
    }

    if (!dto.paymentMethod || !dto.paidAt) {
      throw new BusinessError('INVALID_DATA', 'Método de pago y fecha son obligatorios.');
    }

    validateReportPaymentMethod(dto.paymentMethod);

    if (!isValidDateString(dto.paidAt)) {
      throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${dto.paidAt}. Use formato YYYY-MM-DD.`);
    }

    const paidAt = parseDateOnly(dto.paidAt);

    const allPeriods = await billingPeriodRepository.listBySubscriptionId(subscription.id, organizationId);

    const unpaidCount = allPeriods.filter((p) => p.status === 'PENDING' || p.status === 'OVERDUE').length;
    if (unpaidCount > 0) {
      throw new BusinessError('HAS_UNPAID_PERIODS', 'La suscripción tiene períodos pendientes o vencidos. Cóbrelos primero antes de pagar por adelantado.');
    }

    if (allPeriods.length === 0) {
      throw new BusinessError('NO_PERIODS', 'La suscripción no tiene períodos registrados.');
    }

    const anchor = [...allPeriods].sort((a, b) => b.endDate.getTime() - a.endDate.getTime())[0];

    if (anchor.status !== 'PAID') {
      throw new BusinessError('INVALID_PERIOD_STATE', 'Solo se puede pagar por adelantado cuando el último período está pagado.');
    }

    const alreadyExists = allPeriods.some((p) => p.startDate.getTime() === anchor.endDate.getTime());
    if (alreadyExists) {
      throw new BusinessError('PERIOD_ALREADY_EXISTS', 'El siguiente ciclo ya existe. Recargue los períodos.');
    }

    const plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
    if (!plan) {
      throw new BusinessError('PLAN_NOT_FOUND', 'Plan no encontrado.');
    }
    if (!plan.active) {
      throw new BusinessError('PLAN_INACTIVE', 'El plan debe estar activo.');
    }

    const advancePeriod = businessService.createAdvanceBillingPeriod({
      anchorPeriod: anchor,
      subscription,
      plan,
      paymentMethod: dto.paymentMethod,
      paidAt,
      notes: dto.notes,
    });

    await billingPeriodRepository.create(advancePeriod);

    try {
      await domainEventRepository.create({
        id: createId(),
        type: 'billing_period.generated',
        organizationId: advancePeriod.organizationId,
        actorUserId: auth.userId,
        entity: 'billingPeriod',
        entityId: advancePeriod.id,
        payload: { subscriptionId: subscription.id, advance: true, anchorPeriodId: anchor.id },
        createdAt: new Date(),
      });
      await domainEventRepository.create({
        id: createId(),
        type: 'billing_period.paid',
        organizationId: advancePeriod.organizationId,
        actorUserId: auth.userId,
        entity: 'billingPeriod',
        entityId: advancePeriod.id,
        payload: { subscriptionId: subscription.id, amount: advancePeriod.amount, paymentMethod: dto.paymentMethod, advance: true },
        createdAt: new Date(),
      });
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando pay-advance:', eventError);
    }

    const updatedSubscription = applyRadarToSubscription(subscription, [...allPeriods, advancePeriod]);
    await subscriptionRepository.update(updatedSubscription);
    scheduleStatsRecompute(organizationId);

    res.json({
      billingPeriod: advancePeriod,
      subscription: {
        id: updatedSubscription.id,
        status: updatedSubscription.status,
        previousStatus: subscription.status,
        reactivated: false,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
