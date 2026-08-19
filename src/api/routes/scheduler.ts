import { Router, Request, Response, NextFunction } from 'express';
import { schedulerConfigRepository, organizationRepository } from '../../infrastructure/repositories';
import { runDailyJob, reschedule, runDailyJobForOrganization } from '../../infrastructure/scheduler';
import { BusinessError } from '../../domain/entities';
import cron from 'node-cron';
import { getAuth, getEffectiveOrganizationId } from '../middleware/tenant';
import { isSuperAdmin } from '../../domain/auth-context';

const router = Router();

router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const config = await schedulerConfigRepository.getConfig(organizationId);
    res.json({ ...config, organizationId: organizationId || null });
  } catch (err) {
    next(err);
  }
});

router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const { enabled, cronSchedule } = req.body;

    if (enabled !== undefined && typeof enabled !== 'boolean') {
      throw new BusinessError('INVALID_DATA', 'El campo "enabled" debe ser booleano.');
    }

    if (cronSchedule !== undefined) {
      if (typeof cronSchedule !== 'string' || !cron.validate(cronSchedule)) {
        throw new BusinessError('INVALID_CRON', 'El campo "cronSchedule" debe ser una expresión cron válida.');
      }
    }

    const updates: { enabled?: boolean; cronSchedule?: string } = {};
    if (enabled !== undefined) updates.enabled = enabled;
    if (cronSchedule !== undefined) updates.cronSchedule = cronSchedule;

    const config = await schedulerConfigRepository.updateConfig(updates, organizationId);

    if (!organizationId) {
      await reschedule();
    }

    res.json({ ...config, organizationId: organizationId || null });
  } catch (err) {
    next(err);
  }
});

router.post('/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const organizationId = getEffectiveOrganizationId(req);

    if (organizationId) {
      const organization = await organizationRepository.getById(organizationId);
      if (!organization || !organization.active) {
        throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización indicada no existe o está inactiva.');
      }
      const result = await runDailyJobForOrganization(organizationId);
      if (result.skipped) {
        throw new BusinessError(
          'JOB_ALREADY_RUNNING',
          `El Daily Job ya está en ejecución para la organización ${organizationId}.`
        );
      }
      return res.json({ message: `Daily Job ejecutado correctamente para la organización ${organizationId}.` });
    }

    if (isSuperAdmin(auth)) {
      await runDailyJob();
      return res.json({ message: 'Daily Job ejecutado correctamente para todas las organizaciones.' });
    }

    throw new BusinessError('TENANT_REQUIRED', 'No se pudo determinar la organización para ejecutar el Daily Job.');
  } catch (err) {
    next(err);
  }
});

export default router;
