import { Router, Request, Response, NextFunction } from 'express';
import {
  paymentReportRepository,
  whatsappConversationRepository,
} from '../../infrastructure/repositories';
import { badgesCache } from '../../infrastructure/badge-cache';
import { requireOrganizationId } from '../middleware/tenant';

const router = Router();

interface BadgeCounts {
  unreadChats: number;
  pendingReports: number;
  generatedAt: string;
}

/**
 * GET /api/badges
 *
 * Devuelve ambos contadores de la barra de navegación en una sola llamada:
 * - pendingReports: reportes de pago PENDING (agregación `count()`).
 * - unreadChats: conversaciones con entrantes sin leer (agregación `count()`).
 *
 * El resultado se cachea por organización (TTL configurable con
 * BADGES_CACHE_TTL_MS) con "single-flight", de modo que varios admins
 * simultáneos comparten una única ejecución de las agregaciones. La caché se
 * invalida en cada escritura relevante (mensaje entrante, marcar leído,
 * revisar/crear reporte).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);

    const counts = await badgesCache.getOrLoad<BadgeCounts>(organizationId, async () => {
      const [unreadChats, pendingReports] = await Promise.all([
        whatsappConversationRepository.countUnread(organizationId),
        paymentReportRepository.countWhere([
          ['organizationId', '==', organizationId],
          ['status', '==', 'PENDING'],
        ]),
      ]);

      return {
        unreadChats,
        pendingReports,
        generatedAt: new Date().toISOString(),
      };
    });

    res.json(counts);
  } catch (err) {
    next(err);
  }
});

export default router;
