import { Router, Request, Response, NextFunction } from 'express';
import { schedulerConfigRepository } from '../../infrastructure/repositories';
import { runDailyJob, reschedule } from '../../infrastructure/scheduler';
import { BusinessError } from '../../domain/entities';
import cron from 'node-cron';

const router = Router();

router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const config = await schedulerConfigRepository.getConfig();
    res.json(config);
  } catch (err) {
    next(err);
  }
});

router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
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

    const config = await schedulerConfigRepository.updateConfig(updates);
    await reschedule();

    res.json(config);
  } catch (err) {
    next(err);
  }
});

router.post('/run', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await runDailyJob();
    res.json({ message: 'Daily Job ejecutado correctamente.' });
  } catch (err) {
    next(err);
  }
});

export default router;
