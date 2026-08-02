import { Router, Request, Response, NextFunction } from 'express';
import { planRepository, subscriptionRepository } from '../../infrastructure/repositories';
import { CreatePlanDto, UpdatePlanDto } from '../dto';
import { BusinessError } from '../../domain/entities';
import { createId } from '../../domain/business-rules';

const router = Router();

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreatePlanDto = req.body;

    if (!dto.name || dto.price === undefined || !dto.description) {
      throw new BusinessError('INVALID_DATA', 'Nombre, precio y descripción son obligatorios.');
    }

    if (dto.price < 0) {
      throw new BusinessError('INVALID_PRICE', 'El precio debe ser mayor o igual a cero.');
    }

    const plan = {
      id: createId(),
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

    let plans = await planRepository.list();

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
    const plan = await planRepository.getById(req.params.id);
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
    const existing = await planRepository.getById(req.params.id);

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
    const existing = await planRepository.getById(req.params.id);
    if (!existing) {
      throw new BusinessError('NOT_FOUND', 'Plan no encontrado.');
    }

    const allSubscriptions = await subscriptionRepository.list();
    const linkedSubscriptions = allSubscriptions.filter((s) => s.planId === req.params.id);

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
