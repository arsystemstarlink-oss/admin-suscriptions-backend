import { Router, Request, Response, NextFunction } from 'express';
import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  clientRepository,
  domainEventRepository,
} from '../../infrastructure/repositories';
import { RegisterPaymentDto, UpdateBillingPeriodDto } from '../dto';
import { BillingPeriod, BusinessError } from '../../domain/entities';
import { SubscriptionBusinessService } from '../../domain/subscription-service';
import { parseDateOnly, isValidDateString, createId } from '../../domain/business-rules';
import { getAuth, getEffectiveOrganizationId } from '../middleware/tenant';

const router = Router();
const businessService = new SubscriptionBusinessService();

async function enrichPeriods(periods: BillingPeriod[], organizationId: string | undefined): Promise<any[]> {
  return Promise.all(
    periods.map(async (period) => {
      const subscription = await subscriptionRepository.getByIdScoped(period.subscriptionId, organizationId);
      let client = null;
      let plan = null;

      if (subscription) {
        client = await clientRepository.getByIdScoped(subscription.clientId, organizationId);
        plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
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
    })
  );
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const subscriptionId = req.query.subscriptionId as string;
    const clientId = req.query.clientId as string;
    const status = req.query.status as string;
    const search = req.query.search as string;
    const expiresBefore = req.query.expiresBefore as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const organizationId = getEffectiveOrganizationId(req);

    if (!subscriptionId && !status && !expiresBefore && !clientId && !search) {
      const page = await billingPeriodRepository.listPage({
        organizationId,
        limit,
        offset,
        orderBy: 'startDate',
        direction: 'desc',
      });
      const enrichedPeriods = await enrichPeriods(page.items, organizationId);
      return res.json({
        periods: enrichedPeriods,
        pagination: {
          total: page.total,
          limit,
          offset,
          hasMore: page.hasMore,
        },
      });
    }

    let periods = await billingPeriodRepository.listByOrganization(organizationId);

    if (subscriptionId) {
      periods = periods.filter((p) => p.subscriptionId === subscriptionId);
    }

    if (status) {
      periods = periods.filter((p) => p.status === status);
    }

    if (expiresBefore) {
      const beforeDate = new Date(expiresBefore);
      if (!isNaN(beforeDate.getTime())) {
        periods = periods.filter((p) => p.endDate <= beforeDate);
      }
    }

    const enrichedPeriods = await enrichPeriods(periods, organizationId);

    let filteredPeriods = enrichedPeriods;

    if (clientId) {
      filteredPeriods = filteredPeriods.filter((p) => p.client?.id === clientId);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      filteredPeriods = filteredPeriods.filter(
        (p) =>
          (p.client?.firstName?.toLowerCase().includes(searchLower)) ||
          (p.client?.lastName?.toLowerCase().includes(searchLower)) ||
          (`${p.client?.firstName ?? ''} ${p.client?.lastName ?? ''}`.toLowerCase().includes(searchLower)) ||
          (p.client?.email?.toLowerCase().includes(searchLower)) ||
          (p.client?.phone?.includes(search)) ||
          (p.subscription?.kitNumber?.toLowerCase().includes(searchLower))
      );
    }

    const sortedPeriods = filteredPeriods.sort(
      (a, b) => b.startDate.getTime() - a.startDate.getTime()
    );

    const total = sortedPeriods.length;
    const paginatedPeriods = sortedPeriods.slice(offset, offset + limit);

    res.json({
      periods: paginatedPeriods,
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
    const dto: UpdateBillingPeriodDto = req.body;
    const organizationId = getEffectiveOrganizationId(req);
    const period = await billingPeriodRepository.getByIdScoped(req.params.id, organizationId);

    if (!period) {
      throw new BusinessError('NOT_FOUND', 'Período no encontrado.');
    }

    let paidAt: Date | undefined;
    if (dto.paidAt !== undefined) {
      if (!isValidDateString(dto.paidAt)) {
        throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${dto.paidAt}. Use formato YYYY-MM-DD.`);
      }
      paidAt = parseDateOnly(dto.paidAt);
    }

    const updatedPeriod = businessService.updateBillingPeriodPaymentData({
      billingPeriod: period,
      paymentMethod: dto.paymentMethod,
      amount: dto.amount,
      paidAt,
      notes: dto.notes,
    });

    await billingPeriodRepository.update(updatedPeriod);

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
    const dto: RegisterPaymentDto = req.body;
    const auth = getAuth(req);
    const organizationId = getEffectiveOrganizationId(req);
    const period = await billingPeriodRepository.getByIdScoped(req.params.id, organizationId);

    if (!period) {
      throw new BusinessError('NOT_FOUND', 'Período no encontrado.');
    }

    if (!dto.paymentMethod || dto.amount === undefined || !dto.paidAt) {
      throw new BusinessError('INVALID_DATA', 'Método de pago, monto y fecha son obligatorios.');
    }

    if (!isValidDateString(dto.paidAt)) {
      throw new BusinessError('INVALID_DATE_FORMAT', `Fecha de pago inválida: ${dto.paidAt}. Use formato YYYY-MM-DD.`);
    }

    const paidAt = parseDateOnly(dto.paidAt);

    const updatedPeriod = businessService.applyPaymentToBillingPeriod({
      billingPeriod: period,
      paymentMethod: dto.paymentMethod,
      amount: dto.amount,
      paidAt,
      notes: dto.notes,
    });

    await billingPeriodRepository.update(updatedPeriod);

    try {
      await domainEventRepository.create({
        id: createId(),
        type: 'billing_period.paid',
        organizationId: period.organizationId,
        actorUserId: auth.userId,
        entity: 'billingPeriod',
        entityId: updatedPeriod.id,
        payload: { subscriptionId: period.subscriptionId, amount: dto.amount, paymentMethod: dto.paymentMethod },
        createdAt: new Date(),
      });
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando billing_period.paid:', eventError);
    }

    const subscription = await subscriptionRepository.getByIdScoped(period.subscriptionId, organizationId);
    let updatedSubscription = subscription;
    let currentPeriod: BillingPeriod | undefined;

    if (subscription) {
      const allPeriods = await billingPeriodRepository.listBySubscriptionId(subscription.id, organizationId);

      updatedSubscription = businessService.evaluateSubscriptionStatus(
        subscription,
        allPeriods
      );

      if (updatedSubscription.status !== subscription.status) {
        await subscriptionRepository.update(updatedSubscription);
      }

      if (subscription.status === 'SUSPENDED' && updatedSubscription.status === 'ACTIVE') {
        const plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
        if (!plan) {
          throw new BusinessError('PLAN_NOT_FOUND', 'Plan no encontrado.');
        }

        const generatedPeriod = businessService.generateCurrentPeriod({
          subscription: updatedSubscription,
          plan,
          now: new Date(),
        });

        await billingPeriodRepository.create(generatedPeriod);
        currentPeriod = generatedPeriod;
      }
    }

    res.json({
      billingPeriod: updatedPeriod,
      currentPeriod,
      subscription: updatedSubscription
        ? {
            id: updatedSubscription.id,
            status: updatedSubscription.status,
            previousStatus: subscription?.status,
            reactivated: subscription?.status === 'SUSPENDED' && updatedSubscription.status === 'ACTIVE',
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
