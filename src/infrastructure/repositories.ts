import { FirestoreRepository } from './firestore-repository';
import { createId } from '../domain/business-rules';
import { Client, Plan, Subscription, BillingPeriod, User, SchedulerConfig, WhatsAppMessage, WhatsAppConversation, RefreshTokenSession, PushSubscription } from '../domain/entities';

export class ClientFirestoreRepository extends FirestoreRepository<Client> {
  constructor() {
    super('clients');
  }
}

export class PlanFirestoreRepository extends FirestoreRepository<Plan> {
  constructor() {
    super('plans');
  }
}

export class SubscriptionFirestoreRepository extends FirestoreRepository<Subscription> {
  constructor() {
    super('subscriptions');
  }

  async listByClientId(clientId: string): Promise<Subscription[]> {
    return this.listByField('clientId', clientId);
  }
}

export class BillingPeriodFirestoreRepository extends FirestoreRepository<BillingPeriod> {
  constructor() {
    super('billingPeriods');
  }

  async listBySubscriptionId(subscriptionId: string): Promise<BillingPeriod[]> {
    return this.listByField('subscriptionId', subscriptionId);
  }

  async deleteBySubscriptionId(subscriptionId: string): Promise<number> {
    return this.deleteByField('subscriptionId', subscriptionId);
  }
}

export class UserFirestoreRepository extends FirestoreRepository<User> {
  constructor() {
    super('users');
  }

  async findByEmail(email: string): Promise<User | undefined> {
    const results = await this.listByField('email', email);
    return results[0];
  }
}

export class RefreshTokenSessionFirestoreRepository extends FirestoreRepository<RefreshTokenSession> {
  constructor() {
    super('refreshTokenSessions');
  }

  async listByUserId(userId: string): Promise<RefreshTokenSession[]> {
    return this.listByField('userId', userId);
  }

  async revokeAllForUser(userId: string): Promise<number> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where('userId', '==', userId)
      .get();

    const now = new Date();
    const batch = this.db.batch();
    snapshot.docs.forEach((doc) => {
      batch.update(doc.ref, { revokedAt: now });
    });

    await batch.commit();
    return snapshot.size;
  }
}

export class SchedulerConfigFirestoreRepository extends FirestoreRepository<SchedulerConfig> {
  private static readonly CONFIG_ID = 'daily-job';

  constructor() {
    super('schedulerConfig');
  }

  async getConfig(): Promise<SchedulerConfig> {
    const config = await this.getById(SchedulerConfigFirestoreRepository.CONFIG_ID);
    if (!config) {
      const defaultConfig: SchedulerConfig = {
        id: SchedulerConfigFirestoreRepository.CONFIG_ID,
        enabled: true,
        cronSchedule: '0 0 * * *',
        updatedAt: new Date(),
      };
      await this.create(defaultConfig);
      return defaultConfig;
    }
    return config;
  }

  async updateConfig(updates: Partial<Pick<SchedulerConfig, 'enabled' | 'cronSchedule' | 'lastRun'>>): Promise<SchedulerConfig> {
    const config = await this.getConfig();
    const updated: SchedulerConfig = {
      ...config,
      ...updates,
      updatedAt: new Date(),
    };
    await this.update(updated);
    return updated;
  }
}

export class WhatsAppMessageFirestoreRepository extends FirestoreRepository<WhatsAppMessage> {
  constructor() {
    super('whatsappMessages');
  }

  async listByClientId(clientId: string): Promise<WhatsAppMessage[]> {
    return this.listByField('clientId', clientId);
  }

  async listByPhone(phone: string): Promise<WhatsAppMessage[]> {
    return this.listByField('phone', phone);
  }

  async listConversations(): Promise<WhatsAppConversation[]> {
    const messages = await this.list();

    const byPhone = new Map<string, WhatsAppConversation>();
    for (const message of messages) {
      const existing = byPhone.get(message.phone);

      if (!existing) {
        byPhone.set(message.phone, {
          phone: message.phone,
          clientId: message.clientId,
          profileName: message.profileName,
          lastMessage: message,
          messageCount: 1,
        });
        continue;
      }

      existing.messageCount += 1;
      if (message.createdAt.getTime() > existing.lastMessage.createdAt.getTime()) {
        existing.lastMessage = message;
        existing.clientId = message.clientId ?? existing.clientId;
        existing.profileName = message.profileName ?? existing.profileName;
      }
    }

    return [...byPhone.values()];
  }
}

export class PushSubscriptionFirestoreRepository extends FirestoreRepository<PushSubscription> {
  constructor() {
    super('pushSubscriptions');
  }

  async findByEndpoint(endpoint: string): Promise<PushSubscription | undefined> {
    const results = await this.listByField('endpoint', endpoint);
    return results[0];
  }

  async listByAdminId(adminId: string): Promise<PushSubscription[]> {
    return this.listByField('adminId', adminId);
  }

  async upsertByEndpoint(
    endpoint: string,
    data: { adminId: string; p256dh: string; auth: string; userAgent?: string }
  ): Promise<PushSubscription> {
    const existing = await this.findByEndpoint(endpoint);
    const now = new Date();

    if (existing) {
      const updated: PushSubscription = {
        ...existing,
        adminId: data.adminId,
        p256dh: data.p256dh,
        auth: data.auth,
        userAgent: data.userAgent,
        updatedAt: now,
      };
      await this.update(updated);
      return updated;
    }

    const created: PushSubscription = {
      id: createId(),
      adminId: data.adminId,
      endpoint,
      p256dh: data.p256dh,
      auth: data.auth,
      userAgent: data.userAgent,
      createdAt: now,
      updatedAt: now,
    };
    await this.create(created);
    return created;
  }
}

export const clientRepository = new ClientFirestoreRepository();
export const planRepository = new PlanFirestoreRepository();
export const subscriptionRepository = new SubscriptionFirestoreRepository();
export const billingPeriodRepository = new BillingPeriodFirestoreRepository();
export const userRepository = new UserFirestoreRepository();
export const refreshTokenSessionRepository = new RefreshTokenSessionFirestoreRepository();
export const schedulerConfigRepository = new SchedulerConfigFirestoreRepository();
export const whatsappMessageRepository = new WhatsAppMessageFirestoreRepository();
export const pushSubscriptionRepository = new PushSubscriptionFirestoreRepository();
