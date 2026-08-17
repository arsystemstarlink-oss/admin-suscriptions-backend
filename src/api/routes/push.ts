import { Router, Request, Response, NextFunction } from 'express';
import { BusinessError } from '../../domain/entities';
import { authenticateAdmin, AuthenticatedRequest } from '../middleware/auth';
import { pushService, PushRegistrationInput } from '../../infrastructure/push-service';
import { userRepository } from '../../infrastructure/repositories';

const router = Router();

router.get('/vapid-public-key', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const vapidPublicKey = pushService.getVapidPublicKey();
    res.json({ vapidPublicKey });
  } catch (err) {
    next(err);
  }
});

router.use(authenticateAdmin);

router.post('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { endpoint, keys, userAgent } = req.body as PushRegistrationInput;

    if (!endpoint || !keys || !keys.p256dh || !keys.auth) {
      throw new BusinessError(
        'INVALID_PAYLOAD',
        'El body debe incluir "endpoint", "keys.p256dh" y "keys.auth".'
      );
    }

    const adminId = (req as AuthenticatedRequest).user!.userId;
    const subscription = await pushService.registerSubscription(adminId, {
      endpoint,
      keys,
      userAgent,
    });

    res.status(201).json({
      subscription: {
        id: subscription.id,
        endpoint: subscription.endpoint,
        userAgent: subscription.userAgent,
        createdAt: subscription.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/subscriptions', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as AuthenticatedRequest).user!.userId;
    const subscriptions = await pushService.listByAdmin(adminId);

    res.json({
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        endpoint: s.endpoint,
        userAgent: s.userAgent,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.delete('/subscriptions/:endpoint', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as AuthenticatedRequest).user!.userId;
    await pushService.deleteByEndpoint(adminId, req.params.endpoint);

    res.json({ message: 'Suscripción eliminada' });
  } catch (err) {
    next(err);
  }
});

router.post('/test', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const adminId = (req as AuthenticatedRequest).user!.userId;
    const sent = await pushService.sendTest(adminId);

    res.json({ message: 'Notificación enviada', sent });
  } catch (err) {
    next(err);
  }
});

router.post('/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { adminIds, title, body, data } = req.body;

    if (!title || !body) {
      throw new BusinessError(
        'INVALID_PAYLOAD',
        'Los campos "title" y "body" son obligatorios.'
      );
    }

    let sent: number;
    if (adminIds === undefined || adminIds === null) {
      sent = await pushService.sendBroadcast({ title, body, data });
    } else {
      if (!Array.isArray(adminIds) || adminIds.some((id) => typeof id !== 'string')) {
        throw new BusinessError(
          'INVALID_PAYLOAD',
          'El campo "adminIds" debe ser un arreglo de strings.'
        );
      }

      const allAdmins = await userRepository.list();
      const validAdminIds = allAdmins.filter((u) => u.role === 'admin').map((u) => u.id);
      const targets = adminIds.filter((id: string) => validAdminIds.includes(id));

      sent = await pushService.sendToAdmins(targets, { title, body, data });
    }

    res.json({ message: 'Notificación enviada', sent });
  } catch (err) {
    next(err);
  }
});

export default router;
