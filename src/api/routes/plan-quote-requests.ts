import { Router, Request, Response, NextFunction } from 'express';
import { planQuoteRequestRepository } from '../../infrastructure/repositories';
import { BusinessError, PlanQuoteRequest, PlanQuoteRequestStatus } from '../../domain/entities';
import { getAuth } from '../middleware/tenant';
import { requireSuperAdmin } from '../middleware/auth';

const router = Router();

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function isStatus(value: unknown): value is PlanQuoteRequestStatus {
  return value === 'NEW' || value === 'CONTACTED' || value === 'CLOSED';
}

router.use(requireSuperAdmin);

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.query.status as string) || 'NEW';
    const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string, 10) || 0, 0);

    if (status !== 'ALL' && !isStatus(status)) {
      throw new BusinessError('INVALID_FILTER', 'El estado de la cotización no es válido.');
    }

    let items: PlanQuoteRequest[];
    let total: number;
    if (status === 'ALL') {
      const page = await planQuoteRequestRepository.listPage({
        orderBy: 'createdAt',
        direction: 'desc',
        limit,
        offset,
        requireTotal: true,
      });
      items = page.items;
      total = page.total ?? page.items.length;
    } else {
      const matching = await planQuoteRequestRepository.listByField('status', status);
      matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      total = matching.length;
      items = matching.slice(offset, offset + limit);
    }

    res.json({
      requests: items,
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + items.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const request = await planQuoteRequestRepository.getById(req.params.id);
    if (!request) {
      throw new BusinessError('NOT_FOUND', 'Solicitud de cotización no encontrada.');
    }

    const status = req.body?.status;
    if (status !== 'CONTACTED' && status !== 'CLOSED') {
      throw new BusinessError(
        'INVALID_DATA',
        'El estado debe ser CONTACTED o CLOSED.',
      );
    }

    const actor = getAuth(req);
    const now = new Date();
    const updated: PlanQuoteRequest = {
      ...request,
      status,
      reviewNotes: optionalText(req.body?.reviewNotes, 1000) ?? request.reviewNotes,
      handledBy: actor.userId,
      handledAt: now,
      updatedAt: now,
    };
    await planQuoteRequestRepository.update(updated);
    res.json({ request: updated });
  } catch (err) {
    next(err);
  }
});

export default router;
