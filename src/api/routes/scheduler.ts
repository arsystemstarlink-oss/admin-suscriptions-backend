import { Router, Request, Response, NextFunction } from 'express';
import { schedulerConfigRepository, schedulerLogRepository, organizationRepository } from '../../infrastructure/repositories';
import { runDailyJob, runDailyJobForOrganization, scheduleOrganization, rescheduleAllOrganizations } from '../../infrastructure/scheduler';
import { BusinessError } from '../../domain/entities';
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
      if (typeof cronSchedule !== 'string' || !/^(\*|([0-9]|([1-5][0-9]))|\*\/[0-9]+)( (\*|([0-9]|([1-5][0-9]))|\*\/[0-9]+)){4}$/.test(cronSchedule)) {
        throw new BusinessError('INVALID_CRON', 'El campo "cronSchedule" debe ser una expresión cron válida.');
      }
    }

    const updates: { enabled?: boolean; cronSchedule?: string } = {};
    if (enabled !== undefined) updates.enabled = enabled;
    if (cronSchedule !== undefined) updates.cronSchedule = cronSchedule;

    const config = await schedulerConfigRepository.updateConfig(updates, organizationId);

    try {
      if (organizationId) {
        await scheduleOrganization(organizationId);
      } else {
        await rescheduleAllOrganizations();
      }
    } catch (scheduleErr) {
      console.error(`[Scheduler] Error al reprogramar cron tras actualizar config:`, scheduleErr);
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
      return res.json({
        success: true,
        message: `Daily Job ejecutado correctamente para la organización ${organizationId}.`,
        result,
      });
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

router.get('/logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const limit = parseInt(req.query.limit as string) || 50;

    if (organizationId) {
      const logs = await schedulerLogRepository.listByOrganization(organizationId, limit);
      return res.json({ logs, total: logs.length, limit });
    }

    const page = await schedulerLogRepository.listPage({
      limit,
      offset: 0,
      orderBy: 'startedAt',
      direction: 'desc',
      requireTotal: true,
    });
    res.json({ logs: page.items, total: page.total, limit });
  } catch (err) {
    next(err);
  }
});

export default router;
