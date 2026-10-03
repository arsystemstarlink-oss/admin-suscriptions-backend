import { Router, Request, Response, NextFunction } from 'express';
import { 
  clientRepository,
  subscriptionRepository,
  billingPeriodRepository,
  planRepository,
} from '../../infrastructure/repositories';
import { CreateClientDto, UpdateClientDto } from '../dto';
import { scheduleStatsRecompute } from '../../infrastructure/stats-service';
import { BusinessError, Client } from '../../domain/entities';
import { createId, normalizeDni, isValidDni } from '../../domain/business-rules';
import { getAuth, requireOrganizationId, resolveCreateOrganizationId } from '../middleware/tenant';

const router = Router();

async function enrichClients(
  clients: Client[],
  organizationId: string | undefined,
  includeSubscriptions: boolean
): Promise<any[]> {
  if (clients.length === 0) {
    return [];
  }

  const allSubs = await subscriptionRepository.listByClientIds(
    clients.map((c) => c.id),
    organizationId
  );
  const allPeriods = await billingPeriodRepository.listBySubscriptionIds(
    allSubs.map((s) => s.id),
    organizationId
  );

  const subsByClientId = new Map<string, any[]>();
  for (const sub of allSubs) {
    const list = subsByClientId.get(sub.clientId) || [];
    list.push(sub);
    subsByClientId.set(sub.clientId, list);
  }

  const periodsBySubscriptionId = new Map<string, any[]>();
  for (const period of allPeriods) {
    const list = periodsBySubscriptionId.get(period.subscriptionId) || [];
    list.push(period);
    periodsBySubscriptionId.set(period.subscriptionId, list);
  }

  return clients.map((client) => {
    const subs = subsByClientId.get(client.id) || [];
    const allSubPeriods = subs.flatMap((s) => periodsBySubscriptionId.get(s.id) || []);

    const overdueCount = allSubPeriods.filter((p: any) => p.status === 'OVERDUE').length;
    const hasDebt = overdueCount > 0;
    const activeSubs = subs.filter((s: any) => s.status === 'ACTIVE');
    const suspendedSubs = subs.filter((s: any) => s.status === 'SUSPENDED');

    let subscriptionStatusValue = 'NONE';
    if (activeSubs.length > 0 && suspendedSubs.length > 0) subscriptionStatusValue = 'MIXED';
    else if (activeSubs.length > 0) subscriptionStatusValue = 'ACTIVE';
    else if (suspendedSubs.length > 0) subscriptionStatusValue = 'SUSPENDED';

    const currentPeriods = subs.map((s: any) => {
      const periods = (periodsBySubscriptionId.get(s.id) || []).slice();
      periods.sort((a: any, b: any) => b.startDate.getTime() - a.startDate.getTime());
      return periods[0];
    });

    return {
      ...client,
      subscriptionStatus: subscriptionStatusValue,
      hasDebt,
      overdueCount,
      totalSubscriptions: subs.length,
      subscriptions: includeSubscriptions
        ? subs.map((s: any, i: number) => ({ ...s, currentPeriod: currentPeriods[i] }))
        : undefined,
    };
  });
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreateClientDto = req.body;
    const auth = getAuth(req);
    const organizationId = resolveCreateOrganizationId(req);

    if (!dto.firstName || !dto.lastName || !dto.phone) {
      throw new BusinessError('INVALID_DATA', 'Nombre, apellido y teléfono son obligatorios.');
    }

    let dni: string | undefined;
    if (dto.dni !== undefined && dto.dni !== null && dto.dni.trim() !== '') {
      dni = normalizeDni(dto.dni);
      if (!isValidDni(dni)) {
        throw new BusinessError('INVALID_DNI', 'Cédula inválida. Use formato V-12345678 o J-123456789 (7-9 dígitos).');
      }
      const existing = await clientRepository.findByDni(dni, organizationId);
      if (existing) {
        throw new BusinessError('DNI_TAKEN', 'Ya existe un cliente registrado con esa cédula de identidad en esta organización.');
      }
    }

    const client = {
      id: createId(),
      organizationId,
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      dni,
      email: dto.email,
      address: dto.address,
      notes: dto.notes,
      createdAt: new Date(),
      createdByUserId: auth.userId,
      createdByRole: auth.role,
    };

    await clientRepository.create(client);
    scheduleStatsRecompute(organizationId);
    res.status(201).json(client);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;
    const include = req.query.include as string;
    const subscriptionStatus = req.query.subscriptionStatus as string;
    const hasOverdue = req.query.hasOverdue as string;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const offset = parseInt(req.query.offset as string) || 0;
    const cursor = req.query.cursor as string | undefined;
    const organizationId = requireOrganizationId(req);

    const shouldIncludeSubscriptions =
      include === 'subscriptions' || Boolean(subscriptionStatus) || hasOverdue !== undefined;

    if (search) {
      const matched = await clientRepository.searchBounded(organizationId, search, limit);
      let clients: any[] = matched;
      if (shouldIncludeSubscriptions) {
        clients = await enrichClients(clients, organizationId, include === 'subscriptions');
      }
      if (subscriptionStatus) {
        clients = clients.filter((c) => c.subscriptionStatus === subscriptionStatus);
      }
      if (hasOverdue !== undefined) {
        const wantOverdue = hasOverdue === 'true';
        clients = clients.filter((c) => c.hasDebt === wantOverdue);
      }
      const total = clients.length;
      const paginated = clients.slice(offset, offset + limit);
      return res.json({
        clients: paginated,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    }

    const page = await clientRepository.listPage({
      organizationId,
      limit,
      offset,
      cursor,
      orderBy: 'createdAt',
      direction: 'asc',
      requireTotal: !cursor,
    });

    let pageClients: any[] = page.items;
    if (shouldIncludeSubscriptions) {
      pageClients = await enrichClients(page.items, organizationId, include === 'subscriptions');
    }

    if (subscriptionStatus) {
      pageClients = pageClients.filter((c) => c.subscriptionStatus === subscriptionStatus);
    }

    if (hasOverdue !== undefined) {
      const wantOverdue = hasOverdue === 'true';
      pageClients = pageClients.filter((c) => c.hasDebt === wantOverdue);
    }

    return res.json({
      clients: pageClients,
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
    const client = await clientRepository.getByIdScoped(req.params.id, organizationId);

    if (!client) {
      throw new BusinessError('NOT_FOUND', 'Cliente no encontrado.');
    }

    const subscriptions = await subscriptionRepository.listByClientId(req.params.id, organizationId);

    const [plans, allPeriods] = await Promise.all([
      planRepository.listByIds(subscriptions.map((sub) => sub.planId), organizationId),
      billingPeriodRepository.listBySubscriptionIds(subscriptions.map((sub) => sub.id), organizationId),
    ]);

    const plansById = new Map(plans.map((plan) => [plan.id, plan]));
    const periodsBySubscriptionId = new Map<string, any[]>();
    for (const period of allPeriods) {
      const list = periodsBySubscriptionId.get(period.subscriptionId) || [];
      list.push(period);
      periodsBySubscriptionId.set(period.subscriptionId, list);
    }

    const subscriptionsWithDetails = subscriptions.map((sub) => {
      const plan = plansById.get(sub.planId);
      const periods = (periodsBySubscriptionId.get(sub.id) || []).slice();
      periods.sort((a, b) => b.startDate.getTime() - a.startDate.getTime());
      const currentPeriod = periods[0];
      const overduePeriods = periods.filter((p) => p.status === 'OVERDUE');
      const pendingPeriods = periods.filter((p) => p.status === 'PENDING');
      const overdueCount = overduePeriods.length;

      return {
        ...sub,
        plan: plan ? { id: plan.id, name: plan.name, price: plan.price } : null,
        currentPeriod,
        totalPeriods: periods.length,
        overduePeriods: overdueCount,
        pendingPeriods: pendingPeriods.length,
        hasDebt: overdueCount > 0,
      };
    });

    const totalOverdue = subscriptionsWithDetails.reduce((sum, s) => sum + s.overduePeriods, 0);

    res.json({
      client,
      subscriptions: subscriptionsWithDetails,
      summary: {
        totalSubscriptions: subscriptions.length,
        activeSubscriptions: subscriptions.filter((s) => s.status === 'ACTIVE').length,
        suspendedSubscriptions: subscriptions.filter((s) => s.status === 'SUSPENDED').length,
        totalOverdue,
        hasDebt: totalOverdue > 0,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: UpdateClientDto = req.body;
    const organizationId = requireOrganizationId(req);
    const existing = await clientRepository.getByIdScoped(req.params.id, organizationId);

    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Cliente no encontrado.');
    }

    const { dni: _dni, ...dtoRest } = dto;
    let updated: Client = {
      ...existing,
      ...dtoRest,
    };

    if (dto.dni !== undefined) {
      if (dto.dni === null || dto.dni.trim() === '') {
        updated = { ...updated, dni: undefined };
      } else {
        const normalized = normalizeDni(dto.dni);
        if (!isValidDni(normalized)) {
          throw new BusinessError('INVALID_DNI', 'Cédula inválida. Use formato V-12345678 o J-123456789 (7-9 dígitos).');
        }
        const existingWithDni = await clientRepository.findByDni(normalized, organizationId);
        if (existingWithDni && existingWithDni.id !== existing.id) {
          throw new BusinessError('DNI_TAKEN', 'Ya existe un cliente registrado con esa cédula de identidad en esta organización.');
        }
        updated = { ...updated, dni: normalized };
      }
    }

    await clientRepository.update(updated);
    scheduleStatsRecompute(organizationId);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const existing = await clientRepository.getByIdScoped(req.params.id, organizationId);

    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Cliente no encontrado.');
    }

    const subscriptions = await subscriptionRepository.listByClientId(req.params.id, organizationId);
    const activeSubscriptions = subscriptions.filter((s) => s.status === 'ACTIVE');

    if (activeSubscriptions.length > 0) {
      throw new BusinessError(
        'CLIENT_HAS_ACTIVE_SUBSCRIPTIONS',
        `No se puede eliminar el cliente. Tiene ${activeSubscriptions.length} suscripción(es) activa(s). Suspéndalas o elimínelas primero.`
      );
    }

    await clientRepository.delete(req.params.id);
    scheduleStatsRecompute(organizationId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
