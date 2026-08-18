import { Router, Request, Response, NextFunction } from 'express';
import { 
  clientRepository,
  subscriptionRepository,
  billingPeriodRepository 
} from '../../infrastructure/repositories';
import { CreateClientDto, UpdateClientDto } from '../dto';
import { BusinessError, Client } from '../../domain/entities';
import { createId, normalizeDni, isValidDni } from '../../domain/business-rules';
import { getEffectiveOrganizationId, requireOrganizationId, resolveCreateOrganizationId } from '../middleware/tenant';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreateClientDto = req.body;
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
    };

    await clientRepository.create(client);
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
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const organizationId = getEffectiveOrganizationId(req);

    let clients = await clientRepository.listByOrganization(organizationId);

    if (search) {
      const searchLower = search.toLowerCase();
      clients = clients.filter(
        (c) =>
          c.firstName.toLowerCase().includes(searchLower) ||
          c.lastName.toLowerCase().includes(searchLower) ||
          `${c.firstName} ${c.lastName}`.toLowerCase().includes(searchLower) ||
          c.phone.includes(search) ||
          c.dni?.toLowerCase().includes(searchLower) ||
          c.email?.toLowerCase().includes(searchLower)
      );
    }

    const shouldIncludeSubscriptions = include === 'subscriptions' || subscriptionStatus || hasOverdue;

    let enrichedClients: any[];

    if (shouldIncludeSubscriptions) {
      enrichedClients = await Promise.all(
        clients.map(async (client) => {
          const subs = await subscriptionRepository.listByClientId(client.id, organizationId);
          const allPeriods = await Promise.all(
            subs.map((s) => billingPeriodRepository.listBySubscriptionId(s.id, organizationId))
          );

          const overdueCount = allPeriods.flat().filter((p) => p.status === 'OVERDUE').length;
          const hasDebt = overdueCount > 0;
          const activeSubs = subs.filter((s) => s.status === 'ACTIVE');
          const suspendedSubs = subs.filter((s) => s.status === 'SUSPENDED');

          let subscriptionStatusValue = 'NONE';
          if (activeSubs.length > 0 && suspendedSubs.length > 0) subscriptionStatusValue = 'MIXED';
          else if (activeSubs.length > 0) subscriptionStatusValue = 'ACTIVE';
          else if (suspendedSubs.length > 0) subscriptionStatusValue = 'SUSPENDED';

          const currentPeriods = await Promise.all(
            subs.map(async (s) => {
              const periods = await billingPeriodRepository.listBySubscriptionId(s.id, organizationId);
              return periods.sort((a, b) => b.startDate.getTime() - a.startDate.getTime())[0];
            })
          );

          return {
            ...client,
            subscriptionStatus: subscriptionStatusValue,
            hasDebt,
            overdueCount,
            totalSubscriptions: subs.length,
            subscriptions: include === 'subscriptions'
              ? subs.map((s, i) => ({ ...s, currentPeriod: currentPeriods[i] }))
              : undefined,
          };
        })
      );
    } else {
      enrichedClients = clients;
    }

    if (subscriptionStatus) {
      enrichedClients = enrichedClients.filter((c) => c.subscriptionStatus === subscriptionStatus);
    }

    if (hasOverdue !== undefined) {
      const wantOverdue = hasOverdue === 'true';
      enrichedClients = enrichedClients.filter((c) => c.hasDebt === wantOverdue);
    }

    const total = enrichedClients.length;
    const paginatedClients = enrichedClients.slice(offset, offset + limit);

    res.json({
      clients: paginatedClients,
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
    const client = await clientRepository.getByIdScoped(req.params.id, organizationId);

    if (!client) {
      throw new BusinessError('NOT_FOUND', 'Cliente no encontrado.');
    }

    const subscriptions = await subscriptionRepository.listByClientId(req.params.id, organizationId);
    
    const subscriptionsWithDetails = await Promise.all(
      subscriptions.map(async (sub: any) => {
        const periods = await billingPeriodRepository.listBySubscriptionId(sub.id, organizationId);
        const sortedPeriods = periods.sort((a: any, b: any) => b.startDate.getTime() - a.startDate.getTime());
        const currentPeriod = sortedPeriods[0];
        const overdueCount = periods.filter((p: any) => p.status === 'OVERDUE').length;

        return {
          ...sub,
          currentPeriod,
          totalPeriods: periods.length,
          overdueCount,
          hasDebt: overdueCount > 0,
        };
      })
    );

    const totalOverdue = subscriptionsWithDetails.reduce((sum, s) => sum + s.overdueCount, 0);

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
    const organizationId = getEffectiveOrganizationId(req);
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
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
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
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
