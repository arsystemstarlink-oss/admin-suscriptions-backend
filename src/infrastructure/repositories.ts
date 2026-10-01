import { FirestoreRepository, QueryFilter } from './firestore-repository';
import { getFirestore, admin } from './firebase';
import { createId } from '../domain/business-rules';
import {
  Client,
  Plan,
  Subscription,
  BillingPeriod,
  User,
  SchedulerConfig,
  SchedulerLog,
  WhatsAppMessage,
  WhatsAppConversation,
  WhatsAppConversationRecord,
  MessageStatus,
  RefreshTokenSession,
  PushSubscription,
  Organization,
  OrganizationTwilioConfig,
  DomainEvent,
} from '../domain/entities';

function toDate(value: any): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (typeof value?._seconds === 'number') return new Date(value._seconds * 1000);
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

export class OrganizationFirestoreRepository extends FirestoreRepository<Organization> {
  constructor() {
    super('organizations');
  }

  async findBySlug(slug: string): Promise<Organization | undefined> {
    const results = await this.listByField('slug', slug);
    return results[0];
  }

  async findByTwilioPhoneNumber(phoneNumber: string): Promise<Organization | undefined> {
    const results = await this.listByField('twilio.phoneNumber', phoneNumber);
    return results.find((org) => org.twilio?.phoneNumber === phoneNumber);
  }

  async listActive(): Promise<Organization[]> {
    return this.listByField('active', true);
  }

  async updateOrganization(organization: Organization): Promise<void> {
    const docRef = this.db.collection(this.collectionName).doc(organization.id);
    const existing = await docRef.get();

    if (!existing.exists) {
      throw new Error(`Entity with id ${organization.id} does not exist.`);
    }

    const data = this.serialize(organization);
    const updates: Record<string, any> = { ...data };
    delete updates.twilio;

    if (organization.twilio) {
      const fields: (keyof OrganizationTwilioConfig)[] = [
        'accountSid',
        'authToken',
        'phoneNumber',
        'enabled',
      ];
      for (const field of fields) {
        const value = organization.twilio[field];
        updates[`twilio.${field}`] =
          value === undefined ? admin.firestore.FieldValue.delete() : value;
      }
    } else {
      updates.twilio = admin.firestore.FieldValue.delete();
    }

    await docRef.update(updates);
  }
}

export class ClientFirestoreRepository extends FirestoreRepository<Client> {
  constructor() {
    super('clients');
  }

  async findByDni(dni: string, organizationId?: string): Promise<Client | undefined> {
    if (!organizationId) {
      const results = await this.listByField('dni', dni);
      return results[0];
    }
    const results = await this.listByFields([
      ['organizationId', organizationId],
      ['dni', dni],
    ]);
    return results[0];
  }

  async listByOrganizationAndDni(organizationId: string, dni: string): Promise<Client[]> {
    return this.listByFields([
      ['organizationId', organizationId],
      ['dni', dni],
    ]);
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

  async listByClientId(clientId: string, organizationId?: string): Promise<Subscription[]> {
    if (!organizationId) {
      return this.listByField('clientId', clientId);
    }
    return this.listByFields([
      ['organizationId', organizationId],
      ['clientId', clientId],
    ]);
  }

  async listByPlanId(planId: string, organizationId?: string): Promise<Subscription[]> {
    if (!organizationId) {
      return this.listByField('planId', planId);
    }
    return this.listByFields([
      ['organizationId', organizationId],
      ['planId', planId],
    ]);
  }

  async listByClientIds(clientIds: string[], organizationId?: string): Promise<Subscription[]> {
    const unique = [...new Set(clientIds.filter(Boolean))];
    if (unique.length === 0) {
      return [];
    }

    const MAX_IN_FILTER = 30;
    const results: Subscription[] = [];
    for (let i = 0; i < unique.length; i += MAX_IN_FILTER) {
      const chunk = unique.slice(i, i + MAX_IN_FILTER);
      const filters: QueryFilter[] = [['clientId', 'in', chunk]];
      if (organizationId) {
        filters.unshift(['organizationId', '==', organizationId]);
      }
      const snapshot = await this.buildQuery(filters).get();
      snapshot.docs.forEach((doc) =>
        results.push(this.deserialize({ id: doc.id, ...doc.data() }))
      );
    }
    return results;
  }

  async listRadarPage(params: {
    organizationId: string;
    status: 'ACTIVE' | 'SUSPENDED';
    limit: number;
    offset: number;
    requireTotal?: boolean;
  }): Promise<{ items: Subscription[]; total?: number; hasMore: boolean }> {
    const filters: QueryFilter[] = [
      ['organizationId', '==', params.organizationId],
      ['status', '==', params.status],
    ];

    const snapshot = await this.buildQuery(filters)
      .orderBy('radarRank', 'asc')
      .orderBy('nearestPendingDate', 'asc')
      .orderBy('closestOverdueDate', 'desc')
      .orderBy('createdAt', 'desc')
      .offset(params.offset)
      .limit(params.limit)
      .get();

    const items = snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));

    let total: number | undefined;
    if (params.requireTotal) {
      const countSnapshot = await this.buildQuery(filters).count().get();
      total = countSnapshot.data().count;
    }

    const hasMore =
      total !== undefined ? params.offset + items.length < total : items.length >= params.limit;

    return { items, total, hasMore };
  }
}

export class BillingPeriodFirestoreRepository extends FirestoreRepository<BillingPeriod> {
  constructor() {
    super('billingPeriods');
  }

  async listBySubscriptionId(subscriptionId: string, organizationId?: string): Promise<BillingPeriod[]> {
    if (!organizationId) {
      return this.listByField('subscriptionId', subscriptionId);
    }
    return this.listByFields([
      ['organizationId', organizationId],
      ['subscriptionId', subscriptionId],
    ]);
  }

  async deleteBySubscriptionId(subscriptionId: string, organizationId?: string): Promise<number> {
    if (!organizationId) {
      return this.deleteByField('subscriptionId', subscriptionId);
    }
    return this.deleteByFields([
      ['organizationId', organizationId],
      ['subscriptionId', subscriptionId],
    ]);
  }

  async listBySubscriptionIds(
    subscriptionIds: string[],
    organizationId?: string
  ): Promise<BillingPeriod[]> {
    const unique = [...new Set(subscriptionIds.filter(Boolean))];
    if (unique.length === 0) {
      return [];
    }

    const MAX_IN_FILTER = 30;
    const results: BillingPeriod[] = [];
    for (let i = 0; i < unique.length; i += MAX_IN_FILTER) {
      const chunk = unique.slice(i, i + MAX_IN_FILTER);
      const filters: QueryFilter[] = [['subscriptionId', 'in', chunk]];
      if (organizationId) {
        filters.unshift(['organizationId', '==', organizationId]);
      }
      const snapshot = await this.buildQuery(filters).get();
      snapshot.docs.forEach((doc) =>
        results.push(this.deserialize({ id: doc.id, ...doc.data() }))
      );
    }
    return results;
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

  async listByOrganization(organizationId: string): Promise<User[]> {
    return this.listByField('organizationId', organizationId);
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
  constructor() {
    super('schedulerConfig');
  }

  async getConfig(organizationId: string): Promise<SchedulerConfig> {
    const config = await this.getById(organizationId);
    if (!config) {
      const defaultConfig: SchedulerConfig = {
        id: organizationId,
        enabled: true,
        cronSchedule: '0 0 * * *',
        updatedAt: new Date(),
      };
      await this.create(defaultConfig);
      return defaultConfig;
    }
    return config;
  }

  async updateConfig(updates: Partial<Pick<SchedulerConfig, 'enabled' | 'cronSchedule' | 'lastRun'>>, organizationId: string): Promise<SchedulerConfig> {
    const config = await this.getConfig(organizationId);
    const updated: SchedulerConfig = {
      ...config,
      ...updates,
      updatedAt: new Date(),
    };
    await this.update(updated);
    return updated;
  }
}

export class SchedulerLogFirestoreRepository extends FirestoreRepository<SchedulerLog> {
  constructor() {
    super('schedulerLogs');
  }

  async listByOrganization(organizationId: string, limit = 50): Promise<SchedulerLog[]> {
    const snapshot = await this.db
      .collection(this.collectionName)
      .where('organizationId', '==', organizationId)
      .orderBy('startedAt', 'desc')
      .limit(limit)
      .get();
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async createLog(log: SchedulerLog): Promise<void> {
    await this.create(log);
  }
}

export class WhatsAppMessageFirestoreRepository extends FirestoreRepository<WhatsAppMessage> {
  constructor() {
    super('whatsappMessages');
  }

  async listByClientId(clientId: string, organizationId?: string): Promise<WhatsAppMessage[]> {
    if (!organizationId) {
      return this.listByField('clientId', clientId);
    }
    return this.listByFields([
      ['organizationId', organizationId],
      ['clientId', clientId],
    ]);
  }

  async listByPhone(phone: string, organizationId?: string): Promise<WhatsAppMessage[]> {
    if (!organizationId) {
      return this.listByField('phone', phone);
    }
    return this.listByFields([
      ['organizationId', organizationId],
      ['phone', phone],
    ]);
  }

  async deleteByPhone(phone: string, organizationId?: string): Promise<number> {
    if (!organizationId) {
      return this.deleteByField('phone', phone);
    }
    return this.deleteByFields([
      ['organizationId', organizationId],
      ['phone', phone],
    ]);
  }

  async findByMessageSid(messageSid: string): Promise<WhatsAppMessage | undefined> {
    const results = await this.listByField('messageSid', messageSid);
    return results[0];
  }

  async updateStatusByMessageSid(
    messageSid: string,
    status: MessageStatus,
    errorMessage?: string
  ): Promise<void> {
    const results = await this.listByField('messageSid', messageSid);
    for (const message of results) {
      await this.update({
        ...message,
        status,
        ...(errorMessage ? { errorMessage } : {}),
      });
    }
  }

  async listConversations(organizationId?: string): Promise<WhatsAppConversation[]> {
    const messages = await this.listByOrganization(organizationId);

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

export class WhatsAppConversationFirestoreRepository extends FirestoreRepository<WhatsAppConversationRecord> {
  private cacheTtlMs = Number(process.env.CONVERSATION_CACHE_TTL_MS || 600000);
  private maxConversations = Number(process.env.CONVERSATION_LIST_LIMIT || 500);
  private cache = new Map<string, { items: WhatsAppConversationRecord[]; loadedAt: number }>();

  constructor() {
    super('whatsappConversations');
  }

  static docId(organizationId: string, phone: string): string {
    return `${organizationId}__${phone}`;
  }

  private cacheKey(organizationId?: string): string {
    return organizationId ?? '__all__';
  }

  private toRecord(data: any, id: string): WhatsAppConversationRecord {
    const lastMessage = data?.lastMessage
      ? { ...data.lastMessage, createdAt: toDate(data.lastMessage.createdAt) }
      : undefined;
    return {
      id,
      organizationId: data?.organizationId,
      phone: data?.phone,
      clientId: data?.clientId,
      profileName: data?.profileName,
      lastMessage,
      messageCount: data?.messageCount ?? 0,
      createdAt: toDate(data?.createdAt) ?? new Date(),
      updatedAt: toDate(data?.updatedAt) ?? new Date(),
    } as WhatsAppConversationRecord;
  }

  private sortByLastMessage(items: WhatsAppConversationRecord[]): void {
    items.sort((a, b) => {
      const at = a.lastMessage?.createdAt ? a.lastMessage.createdAt.getTime() : 0;
      const bt = b.lastMessage?.createdAt ? b.lastMessage.createdAt.getTime() : 0;
      return bt - at;
    });
  }

  private upsertInCaches(record: WhatsAppConversationRecord): void {
    for (const [key, entry] of this.cache) {
      if (key !== '__all__' && key !== this.cacheKey(record.organizationId)) {
        continue;
      }
      const index = entry.items.findIndex((c) => c.id === record.id);
      if (index >= 0) {
        entry.items[index] = record;
      } else {
        entry.items.push(record);
      }
      this.sortByLastMessage(entry.items);
    }
  }

  private removeFromCaches(organizationId: string, phone: string): void {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
    for (const entry of this.cache.values()) {
      const index = entry.items.findIndex((c) => c.id === id);
      if (index >= 0) {
        entry.items.splice(index, 1);
      }
    }
  }

  async listByOrganization(organizationId?: string): Promise<WhatsAppConversationRecord[]> {
    const key = this.cacheKey(organizationId);
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.loadedAt < this.cacheTtlMs) {
      return cached.items;
    }

    const filters: QueryFilter[] = organizationId
      ? [['organizationId', '==', organizationId]]
      : [];
    const snapshot = await this.buildQuery(filters)
      .orderBy('updatedAt', 'desc')
      .limit(this.maxConversations)
      .get();
    const items = snapshot.docs.map((doc) => this.toRecord(doc.data(), doc.id));
    this.sortByLastMessage(items);
    this.cache.set(key, { items, loadedAt: Date.now() });
    return items;
  }

  async upsertFromMessage(message: WhatsAppMessage, organizationId: string): Promise<void> {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, message.phone);
    const docRef = this.db.collection(this.collectionName).doc(id);
    const now = new Date();

    const record = await this.db.runTransaction(async (tx) => {
      const doc = await tx.get(docRef);
      const incomingAt = toDate(message.createdAt)?.getTime() ?? now.getTime();

      if (!doc.exists) {
        const created: WhatsAppConversationRecord = {
          id,
          organizationId,
          phone: message.phone,
          clientId: message.clientId,
          profileName: message.profileName,
          lastMessage: message,
          messageCount: 1,
          createdAt: now,
          updatedAt: now,
        };
        tx.set(docRef, this.serialize(created));
        return created;
      }

      const existing = this.toRecord(doc.data(), id);
      const existingLastAt = existing.lastMessage?.createdAt?.getTime() ?? 0;
      const isNewer = incomingAt >= existingLastAt;

      const updated: WhatsAppConversationRecord = {
        ...existing,
        clientId: message.clientId ?? existing.clientId,
        profileName: message.profileName ?? existing.profileName,
        lastMessage: isNewer ? message : existing.lastMessage,
        messageCount: existing.messageCount + 1,
        updatedAt: existing.updatedAt.getTime() >= now.getTime() ? existing.updatedAt : now,
      };
      tx.set(docRef, this.serialize(updated));
      return updated;
    });

    this.upsertInCaches(record);
  }

  async updateLastMessageStatus(
    organizationId: string,
    phone: string,
    messageSid: string,
    status: MessageStatus,
    errorMessage?: string
  ): Promise<void> {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
    const docRef = this.db.collection(this.collectionName).doc(id);
    const doc = await docRef.get();
    if (!doc.exists) {
      return;
    }

    const record = this.toRecord(doc.data(), id);
    if (record.lastMessage?.messageSid !== messageSid) {
      return;
    }

    record.lastMessage = {
      ...record.lastMessage,
      status,
      ...(errorMessage ? { errorMessage } : {}),
    };
    record.updatedAt = new Date();

    await docRef.set(this.serialize(record));
    this.upsertInCaches(record);
  }

  async deleteByPhone(organizationId: string, phone: string): Promise<void> {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
    await this.db.collection(this.collectionName).doc(id).delete();
    this.removeFromCaches(organizationId, phone);
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

  async listByOrganization(organizationId: string): Promise<PushSubscription[]> {
    return this.listByField('organizationId', organizationId);
  }

  async upsertByEndpoint(
    endpoint: string,
    data: { organizationId: string; adminId: string; p256dh: string; auth: string; userAgent?: string }
  ): Promise<PushSubscription> {
    const existing = await this.findByEndpoint(endpoint);
    const now = new Date();

    if (existing) {
      const updated: PushSubscription = {
        ...existing,
        organizationId: data.organizationId,
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
      organizationId: data.organizationId,
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

export class DomainEventFirestoreRepository extends FirestoreRepository<DomainEvent> {
  constructor() {
    super('domainEvents');
  }
}

export class JobLockFirestoreRepository {
  private collectionName = 'jobLocks';

  private get db() {
    return getFirestore();
  }

  async acquire(organizationId: string, instanceId: string, ttlMs: number): Promise<boolean> {
    const lockRef = this.db.collection(this.collectionName).doc(organizationId);
    const now = Date.now();

    try {
      await this.db.runTransaction(async (tx) => {
        const doc = await tx.get(lockRef);
        if (doc.exists) {
          const data = doc.data() as { expiresAt?: number } | undefined;
          if (data?.expiresAt && data.expiresAt > now) {
            throw new Error('JOB_LOCKED');
          }
        }
        tx.set(lockRef, { instanceId, lockedAt: now, expiresAt: now + ttlMs });
      });
      return true;
    } catch (error) {
      if ((error as Error).message !== 'JOB_LOCKED') {
        console.warn(`[JobLock] Error adquiriendo lock para ${organizationId}:`, error);
      }
      return false;
    }
  }

  async release(organizationId: string, instanceId: string): Promise<void> {
    const lockRef = this.db.collection(this.collectionName).doc(organizationId);
    const doc = await lockRef.get();
    if (doc.exists && doc.data()?.instanceId === instanceId) {
      await lockRef.delete();
    }
  }
}

export const organizationRepository = new OrganizationFirestoreRepository();
export const clientRepository = new ClientFirestoreRepository();
export const planRepository = new PlanFirestoreRepository();
export const subscriptionRepository = new SubscriptionFirestoreRepository();
export const billingPeriodRepository = new BillingPeriodFirestoreRepository();
export const userRepository = new UserFirestoreRepository();
export const refreshTokenSessionRepository = new RefreshTokenSessionFirestoreRepository();
export const schedulerConfigRepository = new SchedulerConfigFirestoreRepository();
export const schedulerLogRepository = new SchedulerLogFirestoreRepository();
export const whatsappMessageRepository = new WhatsAppMessageFirestoreRepository();
export const whatsappConversationRepository = new WhatsAppConversationFirestoreRepository();
export const pushSubscriptionRepository = new PushSubscriptionFirestoreRepository();
export const domainEventRepository = new DomainEventFirestoreRepository();
export const jobLockRepository = new JobLockFirestoreRepository();
