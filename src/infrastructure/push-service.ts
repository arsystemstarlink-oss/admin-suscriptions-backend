import webpush from 'web-push';
import { BusinessError, PushSubscription } from '../domain/entities';
import { pushSubscriptionRepository, userRepository } from './repositories';

const DEFAULT_TTL = 60 * 60;
const DEFAULT_ICON = 'pwa-192.png';
const DEFAULT_URL = '/dashboard';

export interface PushRegistrationInput {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  userAgent?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  data?: { url?: string; [key: string]: unknown };
}

export class PushService {
  isConfigured(): boolean {
    return Boolean(
      process.env.VAPID_PUBLIC_KEY &&
      process.env.VAPID_PRIVATE_KEY &&
      process.env.VAPID_SUBJECT
    );
  }

  getVapidPublicKey(): string {
    this.ensureConfigured();
    return process.env.VAPID_PUBLIC_KEY as string;
  }

  async registerSubscription(adminId: string, organizationId: string, input: PushRegistrationInput): Promise<PushSubscription> {
    return pushSubscriptionRepository.upsertByEndpoint(input.endpoint, {
      organizationId,
      adminId,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      userAgent: input.userAgent,
    });
  }

  async listByAdmin(adminId: string): Promise<PushSubscription[]> {
    return pushSubscriptionRepository.listByAdminId(adminId);
  }

  async deleteByEndpoint(adminId: string, endpoint: string): Promise<void> {
    const subscription = await pushSubscriptionRepository.findByEndpoint(endpoint);

    if (!subscription || subscription.adminId !== adminId) {
      throw new BusinessError(
        'PUSH_SUBSCRIPTION_NOT_FOUND',
        'La suscripción push no existe o no pertenece al administrador.'
      );
    }

    await pushSubscriptionRepository.delete(subscription.id);
  }

  async sendTest(adminId: string): Promise<number> {
    const payload: PushPayload = {
      title: 'Prueba de notificación',
      body: 'Si recibes esto, las notificaciones push están funcionando.',
      data: { url: DEFAULT_URL },
    };
    return this.sendToAdmins([adminId], payload);
  }

  async sendBroadcast(payload: PushPayload): Promise<number> {
    const admins = await userRepository.list();
    const adminIds = admins.filter((u) => u.role === 'admin').map((u) => u.id);
    return this.sendToAdmins(adminIds, payload);
  }

  async sendBroadcastToOrganization(params: { organizationId: string; title: string; body: string; data?: PushPayload['data'] }): Promise<number> {
    const { organizationId, title, body, data } = params;
    const adminIds = await userRepository
      .listByOrganization(organizationId)
      .then((admins) => admins.filter((u) => u.role === 'admin').map((u) => u.id));
    return this.sendToAdmins(adminIds, { title, body, data });
  }

  async sendToAdmins(adminIds: string[], payload: PushPayload): Promise<number> {
    this.ensureConfigured();

    if (!payload.title || !payload.body) {
      throw new BusinessError(
        'INVALID_PAYLOAD',
        'Los campos "title" y "body" son obligatorios.'
      );
    }

    const subscriptions: PushSubscription[] = [];
    for (const adminId of adminIds) {
      const adminSubs = await pushSubscriptionRepository.listByAdminId(adminId);
      subscriptions.push(...adminSubs);
    }

    let sent = 0;
    for (const subscription of subscriptions) {
      try {
        await this.deliverWithRetry(subscription, payload);
        sent++;
      } catch (error) {
        console.error(
          `[Push] Error enviando a suscripción ${subscription.id}:`,
          error
        );
      }
    }

    return sent;
  }

  private ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new BusinessError(
        'VAPID_NOT_CONFIGURED',
        'Las llaves VAPID no están configuradas en el entorno.'
      );
    }

    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT as string,
      process.env.VAPID_PUBLIC_KEY as string,
      process.env.VAPID_PRIVATE_KEY as string
    );
  }

  private buildPayload(payload: PushPayload): object {
    return {
      title: payload.title,
      body: payload.body,
      icon: DEFAULT_ICON,
      badge: DEFAULT_ICON,
      data: {
        url: DEFAULT_URL,
        ...(payload.data || {}),
      },
    };
  }

  private toWebPushSubscription(subscription: PushSubscription) {
    return {
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: {
        p256dh: subscription.p256dh,
        auth: subscription.auth,
      },
    };
  }

  private async deliverWithRetry(
    subscription: PushSubscription,
    payload: PushPayload,
    attempt = 1
  ): Promise<void> {
    try {
      await webpush.sendNotification(
        this.toWebPushSubscription(subscription),
        JSON.stringify(this.buildPayload(payload)),
        { TTL: DEFAULT_TTL }
      );
    } catch (error: any) {
      const statusCode = error?.statusCode;

      if (statusCode === 404 || statusCode === 410) {
        await pushSubscriptionRepository.delete(subscription.id);
        console.log(
          `[Push] Suscripción ${subscription.id} eliminada (HTTP ${statusCode}).`
        );
        return;
      }

      if (statusCode === 429 && attempt < 3) {
        const backoffMs = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        await this.deliverWithRetry(subscription, payload, attempt + 1);
        return;
      }

      if (statusCode === 403) {
        console.warn(`[Push] Sin permisos para suscripción ${subscription.id} (HTTP 403).`);
        return;
      }

      if (statusCode === 413) {
        console.warn(`[Push] Payload demasiado grande para suscripción ${subscription.id} (HTTP 413).`);
        return;
      }

      throw error;
    }
  }
}

export const pushService = new PushService();
