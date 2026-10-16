import { Router, Request, Response, NextFunction } from 'express';
import {
  paymentReportRepository,
  whatsappConversationRepository,
} from '../../infrastructure/repositories';
import { requireOrganizationId } from '../middleware/tenant';

const router = Router();

/**
 * GET /api/badges
 *
 * Devuelve ambos contadores de la barra de navegación en una sola llamada:
 * - pendingReports: reportes de pago PENDING (agregación `count()`).
 * - unreadChats: conversaciones con entrantes sin leer (agregación `count()`).
 *
 * Evita que el frontend lea colecciones completas (conversaciones/reportes)
 * solo para mostrar un número.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);

    const [unreadChats, pendingReports] = await Promise.all([
      whatsappConversationRepository.countUnread(organizationId),
      paymentReportRepository.countWhere([
        ['organizationId', '==', organizationId],
        ['status', '==', 'PENDING'],
      ]),
    ]);

    res.json({
      unreadChats,
      pendingReports,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
