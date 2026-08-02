import { FirestoreRepository } from './firestore-repository';
import { Client, Plan, Subscription, BillingPeriod, User, SchedulerConfig, WhatsAppMessage } from '../domain/entities';

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
}

export const clientRepository = new ClientFirestoreRepository();
export const planRepository = new PlanFirestoreRepository();
export const subscriptionRepository = new SubscriptionFirestoreRepository();
export const billingPeriodRepository = new BillingPeriodFirestoreRepository();
export const userRepository = new UserFirestoreRepository();
export const schedulerConfigRepository = new SchedulerConfigFirestoreRepository();
export const whatsappMessageRepository = new WhatsAppMessageFirestoreRepository();
