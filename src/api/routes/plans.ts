import { Router, Request, Response, NextFunction } from 'express';
import { planRepository, subscriptionRepository } from '../../infrastructure/repositories';
import { CreatePlanDto, UpdatePlanDto } from '../dto';
import { BusinessError } from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import { getEffectiveOrganizationId, resolveCreateOrganizationId } from '../middleware/tenant';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreatePlanDto = req.body;
    const organizationId = resolveCreateOrganizationId(req);

    if (!dto.name || dto.price === undefined || !dto.description) {
      throw new BusinessError('INVALID_DATA', 'Nombre, precio y descripción son obligatorios.');
    }

    if (dto.price < 0) {
      throw new BusinessError('INVALID_PRICE', 'El precio debe ser mayor o igual a cero.');
    }

    const plan = {
      id: createId(),
      organizationId,
      name: dto.name,
      price: dto.price,
      description: dto.description,
      active: dto.active !== undefined ? dto.active : true,
      createdAt: new Date(),
    };

    await planRepository.create(plan);
    res.status(201).json(plan);
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;
    const active = req.query.active as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const organizationId = getEffectiveOrganizationId(req);

    if (!search && active === undefined) {
      const page = await planRepository.listPage({
        organizationId,
        limit,
        offset,
        orderBy: 'createdAt',
        direction: 'asc',
      });
      return res.json({
        plans: page.items,
        pagination: {
          total: page.total,
          limit,
          offset,
          hasMore: page.hasMore,
        },
      });
    }

    let plans = await planRepository.listByOrganization(organizationId);

    if (search) {
      const searchLower = search.toLowerCase();
      plans = plans.filter(
        (p) =>
          p.name.toLowerCase().includes(searchLower) ||
          p.description.toLowerCase().includes(searchLower)
      );
    }

    if (active !== undefined) {
      const isActive = active === 'true';
      plans = plans.filter((p) => p.active === isActive);
    }

    const total = plans.length;
    const paginatedPlans = plans.slice(offset, offset + limit);

    res.json({
      plans: paginatedPlans,
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
    const plan = await planRepository.getByIdScoped(req.params.id, organizationId);
    if (!plan) {
      throw new BusinessError('NOT_FOUND', 'Plan no encontrado.');
    }
    res.json(plan);
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: UpdatePlanDto = req.body;
    const organizationId = getEffectiveOrganizationId(req);
    const existing = await planRepository.getByIdScoped(req.params.id, organizationId);

    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Plan no encontrado.');
    }

    if (dto.price !== undefined && dto.price < 0) {
      throw new BusinessError('INVALID_PRICE', 'El precio debe ser mayor o igual a cero.');
    }

    const updated = {
      ...existing,
      ...dto,
    };

    await planRepository.update(updated);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const existing = await planRepository.getByIdScoped(req.params.id, organizationId);
    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Plan no encontrado.');
    }

    const linkedSubscriptions = await subscriptionRepository.listByPlanId(req.params.id, organizationId);

    if (linkedSubscriptions.length > 0) {
      throw new BusinessError(
        'PLAN_HAS_SUBSCRIPTIONS',
        `No se puede eliminar el plan. Tiene ${linkedSubscriptions.length} suscripción(es) asociada(s). Reasígnelas a otro plan primero.`
      );
    }

    await planRepository.delete(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
