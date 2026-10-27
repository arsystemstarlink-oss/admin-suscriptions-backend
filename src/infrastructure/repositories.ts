import { FirestoreRepository, QueryFilter, decodeCursor, encodeCursor } from './firestore-repository';
import { getFirestore, admin } from './firebase';
import { invalidateBadges } from './badge-cache';
import { createId, getClientNameUpdateFields, normalizeDni } from '../domain/business-rules';
import {
  recordAggregation,
  recordDocReads,
  recordQuery,
  recordWrite,
} from '../api/middleware/request-id';
import {
  BusinessError,
  BusinessPlanKey,
  AdminInvite,
  Client,
  Plan,
  Subscription,
  BillingPeriod,
  BillingPeriodStatus,
  User,
  SchedulerConfig,
  SchedulerLog,
  WhatsAppMessage,
  WhatsAppConversationRecord,
  MessageStatus,
  RefreshTokenSession,
  PushSubscription,
  Organization,
  OrganizationPlanPayment,
  OrganizationPlanPaymentReport,
  OrganizationTwilioConfig,
  DomainEvent,
  PaymentReport,
} from '../domain/entities';
import { isPlanExpired, validatePlanConfiguration } from '../domain/business-plan';

function toDate(value: any): Date | undefined {
  if (value === undefined || value === null) return undefined;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === 'function') return value.toDate();
  if (typeof value?._seconds === 'number') return new Date(value._seconds * 1000);
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? undefined : parsed;
}

function deserializeOrganization(id: string, data: FirebaseFirestore.DocumentData): Organization {
  return {
    ...data,
    id,
    createdAt: toDate(data.createdAt) ?? new Date(0),
    trialEndsAt: toDate(data.trialEndsAt) ?? null,
    planExpiresAt: toDate(data.planExpiresAt) ?? null,
    planUpdatedAt: toDate(data.planUpdatedAt),
  } as Organization;
}

const TWILIO_PHONE_CLAIMS_COLLECTION = 'twilioPhoneNumbers';

function twilioPhoneClaimRef(db: FirebaseFirestore.Firestore, phoneNumber: string) {
  return db.collection(TWILIO_PHONE_CLAIMS_COLLECTION).doc(phoneNumber);
}

/**
 * Valida dentro de una transacción que `nextPhone` no pertenezca a otra organización
 * y devuelve las escrituras del registro de reservas `twilioPhoneNumbers/{numero}`.
 * Debe invocarse antes de cualquier escritura de la transacción: el callback devuelto
 * solo escribe. El registro garantiza unicidad; la consulta cubre datos previos a la reserva.
 */
async function planTwilioPhoneClaimChange(
  db: FirebaseFirestore.Firestore,
  transaction: FirebaseFirestore.Transaction,
  organizationId: string,
  previousPhone: string | undefined,
  nextPhone: string | undefined,
): Promise<() => void> {
  if (previousPhone === nextPhone) {
    return () => undefined;
  }

  const nextRef = nextPhone ? twilioPhoneClaimRef(db, nextPhone) : undefined;
  const previousRef = previousPhone ? twilioPhoneClaimRef(db, previousPhone) : undefined;

  let nextClaim: FirebaseFirestore.DocumentSnapshot | undefined;
  let previousClaim: FirebaseFirestore.DocumentSnapshot | undefined;
  let nextOwners: FirebaseFirestore.QuerySnapshot | undefined;

  if (nextRef && nextPhone) {
    nextClaim = await transaction.get(nextRef);
    nextOwners = await transaction.get(
      db.collection('organizations').where('twilio.phoneNumber', '==', nextPhone),
    );
    recordDocReads(1 + nextOwners.size);
    const claimedByOther =
      nextClaim.exists && nextClaim.data()?.organizationId !== organizationId;
    const usedByOther = nextOwners.docs.some((doc) => doc.id !== organizationId);
    if (claimedByOther || usedByOther) {
      throw new BusinessError(
        'TWILIO_NUMBER_IN_USE',
        'Ese número de WhatsApp de Twilio ya está asignado a otra organización.'
      );
    }
  }
  if (previousRef) {
    previousClaim = await transaction.get(previousRef);
    recordDocReads();
  }

  return () => {
    if (nextRef) {
      recordWrite();
      transaction.set(nextRef, { organizationId, updatedAt: new Date() });
    }
    if (
      previousRef &&
      previousClaim?.exists &&
      previousClaim.data()?.organizationId === organizationId
    ) {
      recordWrite();
      transaction.delete(previousRef);
    }
  };
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
    const results = (await this.listByField('twilio.phoneNumber', phoneNumber)).filter(
      (org) => org.twilio?.phoneNumber === phoneNumber
    );
    if (results.length > 1) {
      throw new BusinessError(
        'TWILIO_NUMBER_AMBIGUOUS',
        'El número de WhatsApp de Twilio está asociado a más de una organización.'
      );
    }
    return results[0];
  }

  async createWithTwilioClaim(organization: Organization): Promise<void> {
    const docRef = this.db.collection(this.collectionName).doc(organization.id);
    await this.db.runTransaction(async (transaction) => {
      const applyClaims = await planTwilioPhoneClaimChange(
        this.db,
        transaction,
        organization.id,
        undefined,
        organization.twilio?.phoneNumber,
      );
      recordWrite();
      transaction.create(docRef, this.serialize(organization));
      applyClaims();
    });
  }

  async deleteWithTwilioClaim(id: string, phoneNumber: string | undefined): Promise<void> {
    const docRef = this.db.collection(this.collectionName).doc(id);
    const claimRef = phoneNumber ? twilioPhoneClaimRef(this.db, phoneNumber) : undefined;
    await this.db.runTransaction(async (transaction) => {
      const claim = claimRef ? await transaction.get(claimRef) : undefined;
      recordDocReads();
      recordWrite();
      transaction.delete(docRef);
      if (claimRef && claim?.exists && claim.data()?.organizationId === id) {
        recordWrite();
        transaction.delete(claimRef);
      }
    });
  }

  async updateOrganization(
    organization: Organization,
    expected?: Organization,
  ): Promise<Organization> {
    const docRef = this.db.collection(this.collectionName).doc(organization.id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      recordDocReads();
      if (!snapshot.exists) {
        throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
      }
      const current = deserializeOrganization(snapshot.id, snapshot.data()!);
      const applyClaims = await planTwilioPhoneClaimChange(
        this.db,
        transaction,
        organization.id,
        current.twilio?.phoneNumber,
        organization.twilio?.phoneNumber,
      );
      if (
        expected &&
        (current.plan !== expected.plan ||
          current.clientLimit !== expected.clientLimit ||
          current.planStatus !== expected.planStatus ||
          current.trialEndsAt?.getTime() !== expected.trialEndsAt?.getTime() ||
          current.planExpiresAt?.getTime() !== expected.planExpiresAt?.getTime())
      ) {
        throw new BusinessError(
          'PLAN_CONCURRENT_UPDATE',
          'El plan cambió mientras se guardaban los datos. Recarga la organización e inténtalo de nuevo.'
        );
      }
      if (
        current.clientCount !== undefined &&
        organization.clientLimit !== undefined &&
        organization.clientLimit < current.clientCount
      ) {
        throw new BusinessError(
          'CLIENT_LIMIT_BELOW_USAGE',
          'El límite no puede ser menor que la cantidad actual de clientes.'
        );
      }

      const saved = { ...organization, clientCount: current.clientCount };
      const updates: Record<string, any> = { ...this.serialize(saved) };
      delete updates.twilio;
      if (saved.twilio) {
        const fields: (keyof OrganizationTwilioConfig)[] = [
          'accountSid',
          'authToken',
          'phoneNumber',
          'enabled',
        ];
        for (const field of fields) {
          const value = saved.twilio[field];
          updates[`twilio.${field}`] =
            value === undefined ? admin.firestore.FieldValue.delete() : value;
        }
      } else {
        updates.twilio = admin.firestore.FieldValue.delete();
      }
      transaction.update(docRef, updates);
      recordWrite();
      applyClaims();
      return saved;
    });
  }

  async updateWhatsAppConfiguration(
    organizationId: string,
    twilio: OrganizationTwilioConfig | undefined,
    whatsappNotifications: Organization['whatsappNotifications'],
  ): Promise<Organization> {
    const docRef = this.db.collection(this.collectionName).doc(organizationId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      recordDocReads();
      if (!snapshot.exists) {
        throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
      }
      const current = deserializeOrganization(snapshot.id, snapshot.data()!);
      const applyClaims = await planTwilioPhoneClaimChange(
        this.db,
        transaction,
        organizationId,
        current.twilio?.phoneNumber,
        twilio?.phoneNumber,
      );
      transaction.update(docRef, {
        twilio: twilio ? this.serialize(twilio) : admin.firestore.FieldValue.delete(),
        whatsappNotifications: whatsappNotifications
          ? this.serialize(whatsappNotifications)
          : admin.firestore.FieldValue.delete(),
      });
      recordWrite();
      applyClaims();
      return { ...current, twilio, whatsappNotifications };
    });
  }

  async refreshExpiredStatus(organization: Organization, now = new Date()): Promise<Organization> {
    if (!isPlanExpired(organization, now)) {
      return organization;
    }
    const docRef = this.db.collection(this.collectionName).doc(organization.id);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      recordDocReads();
      if (!snapshot.exists) {
        throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
      }
      const current = deserializeOrganization(snapshot.id, snapshot.data()!);
      if (!isPlanExpired(current, now)) {
        return current;
      }
      transaction.update(docRef, { planStatus: 'vencido' });
      recordWrite();
      return { ...current, planStatus: 'vencido' };
    });
  }

  async createWithAdmin(
    organization: Organization,
    user: User,
    invite?: AdminInvite,
  ): Promise<void> {
    const organizationRef = this.db.collection('organizations').doc(organization.id);
    const userRef = this.db.collection('users').doc(user.id);
    const inviteRef = invite ? this.db.collection('adminInvites').doc(invite.id) : undefined;
    const slugQuery = this.db.collection('organizations').where('slug', '==', organization.slug);
    const emailQuery = this.db.collection('users').where('email', '==', user.email);

    await this.db.runTransaction(async (transaction) => {
      const [slugMatches, emailMatches] = await Promise.all([
        transaction.get(slugQuery),
        transaction.get(emailQuery),
      ]);
      recordQuery();
      recordDocReads(slugMatches.size + emailMatches.size);
      if (!slugMatches.empty) {
        throw new BusinessError('SLUG_TAKEN', 'Ya existe una organización con ese slug.');
      }
      if (!emailMatches.empty) {
        throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
      }
      const applyClaims = await planTwilioPhoneClaimChange(
        this.db,
        transaction,
        organization.id,
        undefined,
        organization.twilio?.phoneNumber,
      );
      recordWrite(inviteRef ? 3 : 2);
      transaction.create(organizationRef, this.serialize(organization));
      transaction.create(userRef, this.serialize(user));
      if (inviteRef && invite) {
        transaction.create(inviteRef, this.serialize(invite));
      }
      applyClaims();
    });
  }

  async registerPlanPayment(
    payment: OrganizationPlanPayment,
    plan: BusinessPlanKey,
    clientLimit: number,
    planExpiresAt: Date,
    billingDay: number,
  ): Promise<Organization> {
    const organizationRef = this.db.collection(this.collectionName).doc(payment.organizationId);
    const paymentRef = this.db.collection('organizationPlanPayments').doc(payment.id);

    return this.db.runTransaction(async (transaction) => {
      const organizationSnapshot = await transaction.get(organizationRef);
      recordDocReads();
      if (!organizationSnapshot.exists) {
        throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
      }
      const organization = deserializeOrganization(
        organizationSnapshot.id,
        organizationSnapshot.data()!
      );
      if (planExpiresAt.getTime() <= Date.now()) {
        throw new BusinessError(
          'INVALID_PLAN_DATE',
          'El nuevo vencimiento debe ser una fecha futura para activar el plan.'
        );
      }
      if (clientLimit < (organization.clientCount ?? 0)) {
        throw new BusinessError(
          'CLIENT_LIMIT_BELOW_USAGE',
          'El límite nuevo no puede ser menor que la cantidad actual de clientes.'
        );
      }
      const updated: Organization = {
        ...organization,
        plan,
        clientLimit,
        planStatus: 'activo',
        billingDay,
        trialEndsAt: null,
        planExpiresAt,
        planUpdatedAt: payment.createdAt,
        planUpdatedBy: payment.createdBy,
      };
      recordWrite(2);
      transaction.create(paymentRef, this.serialize(payment));
      transaction.update(organizationRef, this.serialize(updated));
      return updated;
    });
  }
}

export class ClientFirestoreRepository extends FirestoreRepository<Client> {
  constructor() {
    super('clients');
  }

  async createWithinPlanLimit(client: Client): Promise<void> {
    const organizationRef = this.db.collection('organizations').doc(client.organizationId);
    const clientRef = this.db.collection(this.collectionName).doc(client.id);

    const result: { code: string; message: string; details?: Record<string, unknown> } | undefined =
      await this.db.runTransaction(async (transaction) => {
      const [organizationSnapshot, clientSnapshot] = await Promise.all([
        transaction.get(organizationRef),
        transaction.get(clientRef),
      ]);
      recordDocReads(2);
      if (!organizationSnapshot.exists) {
        return { code: 'ORGANIZATION_NOT_FOUND', message: 'Organización no encontrada.' };
      }
      if (clientSnapshot.exists) {
        return { code: 'INVALID_DATA', message: 'El cliente ya existe.' };
      }

      const organization = deserializeOrganization(
        organizationSnapshot.id,
        organizationSnapshot.data()!
      );
      if (isPlanExpired(organization)) {
        recordWrite();
        transaction.update(organizationRef, { planStatus: 'vencido' });
        return {
          code: 'PLAN_READ_ONLY',
          message: 'El plan venció. La organización está en modo de solo lectura.',
        };
      }
      if (
        !organization.plan ||
        !organization.planStatus ||
        !Number.isInteger(organization.clientLimit) ||
        !Number.isInteger(organization.clientCount) ||
        organization.clientCount! < 0
      ) {
        return {
          code: 'PLAN_NOT_CONFIGURED',
          message: 'El plan o el contador de clientes de la organización no está configurado.',
        };
      }
      try {
        validatePlanConfiguration({
          plan: organization.plan,
          clientLimit: organization.clientLimit!,
          planStatus: organization.planStatus,
          trialEndsAt: organization.trialEndsAt,
          planExpiresAt: organization.planExpiresAt,
        });
      } catch (error) {
        if (error instanceof BusinessError) {
          return { code: error.code, message: error.message };
        }
        throw error;
      }
      if (organization.planStatus === 'vencido' || organization.planStatus === 'suspendido') {
        return {
          code: 'PLAN_READ_ONLY',
          message: 'La organización está en modo de solo lectura.',
        };
      }
      if (organization.clientCount! >= organization.clientLimit!) {
        return {
          code: 'CLIENT_LIMIT_REACHED',
          message: 'La organización alcanzó el límite de clientes de su plan.',
          details: {
            clientCount: organization.clientCount,
            clientLimit: organization.clientLimit,
          },
        };
      }

      recordWrite(2);
      transaction.create(clientRef, this.serialize(client));
      transaction.update(organizationRef, { clientCount: organization.clientCount! + 1 });
      return undefined;
    });

    if (result) {
      throw new BusinessError(result.code, result.message, result.details);
    }
  }

  async deleteAndDecrementClientCount(id: string, organizationId: string): Promise<boolean> {
    const clientRef = this.db.collection(this.collectionName).doc(id);
    const organizationRef = this.db.collection('organizations').doc(organizationId);

    return this.db.runTransaction(async (transaction) => {
      const [clientSnapshot, organizationSnapshot] = await Promise.all([
        transaction.get(clientRef),
        transaction.get(organizationRef),
      ]);
      recordDocReads(2);
      if (!clientSnapshot.exists || clientSnapshot.data()?.organizationId !== organizationId) {
        return false;
      }

      if (!organizationSnapshot.exists) {
        throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
      }
      const clientCount = organizationSnapshot.data()?.clientCount;
      if (!Number.isInteger(clientCount) || clientCount < 0) {
        throw new BusinessError(
          'PLAN_NOT_CONFIGURED',
          'El contador de clientes no está inicializado. Ejecuta la migración de planes.'
        );
      }

      recordWrite();
      transaction.delete(clientRef);
      recordWrite();
      transaction.update(organizationRef, { clientCount: Math.max(0, clientCount - 1) });
      return true;
    });
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

  async searchBounded(organizationId: string, term: string, limit: number): Promise<Client[]> {
    if (!organizationId) {
      throw new BusinessError('INVALID_QUERY', 'searchBounded requiere organizationId.');
    }
    const trimmed = term.trim();
    if (!trimmed) {
      return [];
    }

    const results = new Map<string, Client>();
    const push = (items: Client[]) => items.forEach((item) => results.set(item.id, item));

    const dni = normalizeDni(trimmed);
    const exactQueries: Array<Promise<Client[]>> = [
      this.listByFields(
        [
          ['organizationId', organizationId],
          ['phone', trimmed],
        ],
        limit
      ).catch(() => [] as Client[]),
    ];
    if (dni) {
      exactQueries.push(
        this.listByFields(
          [
            ['organizationId', organizationId],
            ['dni', dni],
          ],
          limit
        ).catch(() => [] as Client[])
      );
    }
    for (const items of await Promise.all(exactQueries)) {
      push(items);
    }

    if (results.size < limit) {
      const upper = `${trimmed}\uf8ff`;
      const prefix = async (field: 'firstName' | 'lastName'): Promise<Client[]> => {
        const snapshot = await this.db
          .collection(this.collectionName)
          .where('organizationId', '==', organizationId)
          .where(field, '>=', trimmed)
          .where(field, '<=', upper)
          .orderBy(field)
          .limit(limit)
          .get();
        recordQuery();
        recordDocReads(snapshot.size);
        return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
      };
      const prefixResults = await Promise.all([prefix('firstName'), prefix('lastName')]);
      for (const items of prefixResults) {
        if (results.size >= limit) break;
        push(items);
      }
    }

    return [...results.values()].slice(0, limit);
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
      recordQuery();
      recordDocReads(snapshot.size);
      snapshot.docs.forEach((doc) =>
        results.push(this.deserialize({ id: doc.id, ...doc.data() }))
      );
    }
    return results;
  }

  async searchByKitNumberBounded(
    organizationId: string,
    term: string,
    limit: number
  ): Promise<Subscription[]> {
    const trimmed = term.trim().toUpperCase();
    if (!trimmed) {
      return [];
    }
    const snapshot = await this.db
      .collection(this.collectionName)
      .where('organizationId', '==', organizationId)
      .where('kitNumber', '>=', trimmed)
      .where('kitNumber', '<=', `${trimmed}\uf8ff`)
      .orderBy('kitNumber')
      .limit(limit)
      .get();
    recordQuery();
    recordDocReads(snapshot.size);
    return snapshot.docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));
  }

  async updateClientNameByClientId(
    clientId: string,
    organizationId: string | undefined,
    clientName: string,
    clientSortName: string
  ): Promise<number> {
    const subscriptions = await this.listByClientId(clientId, organizationId);
    const updates = subscriptions
      .map((subscription) => ({
        id: subscription.id,
        fields: getClientNameUpdateFields(subscription, { clientName, clientSortName }),
      }))
      .filter(
        (entry): entry is { id: string; fields: { clientName?: string; clientSortName?: string } } =>
          entry.fields !== undefined
      );
    if (updates.length === 0) return 0;

    const db = this.db;
    const BATCH_SIZE = 400;
    let updated = 0;
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
      const chunk = updates.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      for (const entry of chunk) {
        batch.update(db.collection(this.collectionName).doc(entry.id), entry.fields);
      }
      try {
        await batch.commit();
      } catch (error) {
        console.error('[Subscriptions] Error propagando nombre denormalizado del cliente.', {
          clientId,
          organizationId,
          updatedBeforeFailure: updated,
          failedBatchSize: chunk.length,
          remainingAfterFailedBatch: updates.length - i,
        }, error);
        throw error;
      }
      recordWrite(chunk.length);
      updated += chunk.length;
    }
    return updated;
  }

  /**
   * Consulta accionable del daily job: suscripciones ACTIVE cuyo período
   * actual ya terminó (PAID u OVERDUE) y corresponde generar el siguiente
   * ciclo. Se apoya en el radar denormalizado (currentPeriodStatus /
   * currentPeriodEndDate) para no escanear todo el historial.
   */
  async listGenerationCandidates(
    organizationId: string,
    referenceDate: Date,
    limit = 500
  ): Promise<Subscription[]> {
    const statuses: BillingPeriodStatus[] = ['PAID', 'OVERDUE'];
    const results = await Promise.all(
      statuses.map((currentPeriodStatus) =>
        this.listWhere(
          [
            ['organizationId', '==', organizationId],
            ['status', '==', 'ACTIVE'],
            ['currentPeriodStatus', '==', currentPeriodStatus],
            ['currentPeriodEndDate', '<=', referenceDate],
          ],
          { orderBy: 'currentPeriodEndDate', direction: 'asc', limit }
        )
      )
    );
    return results.flat();
  }

  async listByClientNamePage(params: {
    organizationId: string;
    status?: 'ACTIVE' | 'SUSPENDED';
    clientId?: string;
    hasDebt?: boolean;
    limit: number;
    offset?: number;
    cursor?: string;
    requireTotal?: boolean;
  }): Promise<{ items: Subscription[]; total?: number; hasMore: boolean; nextCursor?: string }> {
    const filters: QueryFilter[] = [['organizationId', '==', params.organizationId]];
    if (params.status) {
      filters.push(['status', '==', params.status]);
    }
    if (params.clientId) {
      filters.push(['clientId', '==', params.clientId]);
    }
    if (params.hasDebt !== undefined) {
      filters.push(['hasDebt', '==', params.hasDebt]);
    }

    const orderByFields = ['clientSortName'];
    let query = this.buildQuery(filters)
      .orderBy(orderByFields[0], 'asc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'asc');

    const decoded = params.cursor ? decodeCursor(params.cursor) : undefined;
    if (decoded && decoded.values.length === orderByFields.length) {
      query = query.startAfter(...decoded.values, decoded.id) as any;
    } else if (params.offset) {
      query = query.offset(params.offset) as any;
    }

    const snapshot = await (query as FirebaseFirestore.Query).limit(params.limit + 1).get();
    recordQuery();
    recordDocReads(snapshot.size);

    const hasExtra = snapshot.docs.length > params.limit;
    const docs = hasExtra ? snapshot.docs.slice(0, params.limit) : snapshot.docs;
    const items = docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() }));

    let total: number | undefined;
    if (params.requireTotal) {
      const countSnapshot = await this.buildQuery(filters).count().get();
      recordAggregation();
      total = countSnapshot.data().count;
    }

    const lastDoc = docs[docs.length - 1];
    const nextCursor =
      hasExtra && lastDoc
        ? encodeCursor(orderByFields.map((field) => lastDoc.get(field)), lastDoc.id)
        : undefined;

    const hasMore =
      total !== undefined && !decoded
        ? (params.offset ?? 0) + items.length < total
        : hasExtra;

    return { items, total, hasMore, nextCursor };
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

  /**
   * Consulta accionable del daily job: solo PENDING ya vencidos
   * (endDate <= now). Acotada con límite + orden por endDate para no
   * inspeccionar todo el historial PENDING futuro.
   */
  async listPendingOverdueCandidates(
    organizationId: string,
    referenceDate: Date,
    limit = 500
  ): Promise<BillingPeriod[]> {
    return this.listWhere(
      [
        ['organizationId', '==', organizationId],
        ['status', '==', 'PENDING'],
        ['endDate', '<=', referenceDate],
      ],
      { orderBy: 'endDate', direction: 'asc', limit }
    );
  }

  /**
   * Consulta accionable del daily job: PENDING por vencer dentro de la ventana
   * de recordatorio [startDate, endDate] (día UTC). Alimenta recordatorios y el
   * aviso de corte del día 0. Reutiliza el índice (organizationId, status, endDate).
   */
  async listReminderWindowCandidates(
    organizationId: string,
    startDate: Date,
    endDate: Date,
    limit = 500
  ): Promise<BillingPeriod[]> {
    return this.listWhere(
      [
        ['organizationId', '==', organizationId],
        ['status', '==', 'PENDING'],
        ['endDate', '>=', startDate],
        ['endDate', '<=', endDate],
      ],
      { orderBy: 'endDate', direction: 'asc', limit }
    );
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
      recordQuery();
      recordDocReads(snapshot.size);
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

export class AdminInviteFirestoreRepository extends FirestoreRepository<AdminInvite> {
  constructor() {
    super('adminInvites');
  }

  async findByTokenHash(tokenHash: string): Promise<AdminInvite | undefined> {
    const results = await this.listByField('tokenHash', tokenHash);
    return results[0];
  }

  /**
   * Marca la invitación como usada solo si sigue pendiente. Devuelve false si
   * otra solicitud la consumió primero, para que el aceptar sea de un solo uso.
   */
  async consume(inviteId: string, usedAt = new Date()): Promise<boolean> {
    const docRef = this.db.collection(this.collectionName).doc(inviteId);
    return this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      recordDocReads();
      if (!snapshot.exists) return false;
      const data = snapshot.data() as { usedAt?: unknown } | undefined;
      if (data?.usedAt) return false;
      recordWrite();
      transaction.update(docRef, { usedAt });
      return true;
    });
  }

  async release(inviteId: string): Promise<void> {
    const docRef = this.db.collection(this.collectionName).doc(inviteId);
    recordWrite();
    await docRef.update({ usedAt: admin.firestore.FieldValue.delete() });
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
    return this.revokeAllForUsers([userId]);
  }

  async revokeAllForUsers(userIds: string[]): Promise<number> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) {
      return 0;
    }

    const MAX_IN_FILTER = 30;
    const now = new Date();
    let revoked = 0;

    for (let i = 0; i < unique.length; i += MAX_IN_FILTER) {
      const chunk = unique.slice(i, i + MAX_IN_FILTER);
      const snapshot = await this.db
        .collection(this.collectionName)
        .where('userId', 'in', chunk)
        .get();
      recordQuery();
      recordDocReads(snapshot.size);

      const docs = snapshot.docs;
      const BATCH_SIZE = 400;
      for (let j = 0; j < docs.length; j += BATCH_SIZE) {
        const chunkDocs = docs.slice(j, j + BATCH_SIZE);
        const batch = this.db.batch();
        chunkDocs.forEach((doc) => {
          batch.update(doc.ref, { revokedAt: now });
        });
        await batch.commit();
        recordWrite(chunkDocs.length);
        revoked += chunkDocs.length;
      }
    }

    return revoked;
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
    recordQuery();
    recordDocReads(snapshot.size);
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

  async listByPhone(phone: string, organizationId?: string): Promise<WhatsAppMessage[]> {
    if (!organizationId) {
      return this.listByField('phone', phone);
    }
    return this.listByFields([
      ['organizationId', organizationId],
      ['phone', phone],
    ]);
  }

  async listByPhonePage(params: {
    organizationId: string;
    phone: string;
    limit: number;
    offset?: number;
    cursor?: string;
  }): Promise<{ items: WhatsAppMessage[]; hasMore: boolean; nextCursor?: string }> {
    const filters: QueryFilter[] = [
      ['organizationId', '==', params.organizationId],
      ['phone', '==', params.phone],
    ];
    let query = this.buildQuery(filters)
      .orderBy('createdAt', 'desc')
      .orderBy(admin.firestore.FieldPath.documentId(), 'desc');

    const decoded = params.cursor ? decodeCursor(params.cursor) : undefined;
    if (decoded && decoded.values.length > 0) {
      query = query.startAfter(...decoded.values, decoded.id);
    } else if (params.offset) {
      query = query.offset(params.offset);
    }

    const snapshot = await query.limit(params.limit + 1).get();
    recordQuery();
    recordDocReads(snapshot.size);

    const hasExtra = snapshot.docs.length > params.limit;
    const docs = hasExtra ? snapshot.docs.slice(0, params.limit) : snapshot.docs;
    const lastDoc = docs[docs.length - 1];
    return {
      items: docs.map((doc) => this.deserialize({ id: doc.id, ...doc.data() })),
      hasMore: hasExtra,
      nextCursor:
        hasExtra && lastDoc ? encodeCursor([lastDoc.get('createdAt')], lastDoc.id) : undefined,
    };
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

  /**
   * Idempotencia del daily job: indica si ya se envió exactamente el mismo
   * mensaje saliente (mismo body serializado = mismo template + período) al
   * teléfono desde `since`. Evita reenviar si el job corre más de una vez al día.
   * Usa el índice (organizationId, phone, createdAt) y filtra direction/body en memoria.
   */
  /**
   * Lectura por lotes para idempotencia del daily job: trae en una sola
   * consulta (por chunks de 30 telefonos, con `in`) los mensajes salientes
   * enviados desde `since`, para no consultar teléfono por teléfono.
   * Reutiliza el índice (organizationId, phone, createdAt).
   */
  async listOutboundSince(params: {
    organizationId: string;
    phones: string[];
    since: Date;
    limit?: number;
  }): Promise<WhatsAppMessage[]> {
    const phones = [...new Set(params.phones.filter(Boolean))];
    if (phones.length === 0) return [];
    const MAX_IN_FILTER = 30;
    const results: WhatsAppMessage[] = [];
    for (let i = 0; i < phones.length; i += MAX_IN_FILTER) {
      const chunk = phones.slice(i, i + MAX_IN_FILTER);
      const messages = await this.listWhere(
        [
          ['organizationId', '==', params.organizationId],
          ['phone', 'in', chunk],
          ['createdAt', '>=', params.since],
        ],
        { orderBy: 'createdAt', direction: 'desc', limit: params.limit ?? 500 }
      );
      results.push(...messages.filter((message) => message.direction === 'OUTBOUND'));
    }
    return results;
  }

  async existsOutboundMessageSince(params: {
    organizationId: string;
    phone: string;
    body: string;
    since: Date;
    limit?: number;
  }): Promise<boolean> {
    const results = await this.listOutboundSince({
      organizationId: params.organizationId,
      phones: [params.phone],
      since: params.since,
      limit: params.limit ?? 100,
    });
    return results.some((message) => message.body === params.body);
  }

  async updateStatusByMessageSid(
    message: WhatsAppMessage,
    status: MessageStatus,
    errorMessage?: string
  ): Promise<void> {
    await this.update({
      ...message,
      status,
      ...(errorMessage ? { errorMessage } : {}),
    });
  }

}

export class WhatsAppConversationFirestoreRepository extends FirestoreRepository<WhatsAppConversationRecord> {
  private cacheTtlMs = Number(process.env.CONVERSATION_CACHE_TTL_MS || 60000);
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
      hasUnread: data?.hasUnread === true,
      lastReadAt: toDate(data?.lastReadAt),
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
    recordQuery();
    recordDocReads(snapshot.size);
    const items = snapshot.docs.map((doc) => this.toRecord(doc.data(), doc.id));
    this.sortByLastMessage(items);
    this.cache.set(key, { items, loadedAt: Date.now() });
    return items;
  }

  private applyMessageToRecord(
    existing: WhatsAppConversationRecord | undefined,
    message: WhatsAppMessage,
    id: string,
    organizationId: string,
    now: Date
  ): WhatsAppConversationRecord {
    const incomingAt = toDate(message.createdAt)?.getTime() ?? now.getTime();

    if (!existing) {
      return {
        id,
        organizationId,
        phone: message.phone,
        clientId: message.clientId,
        profileName: message.profileName,
        lastMessage: message,
        messageCount: 1,
        hasUnread: message.direction === 'INBOUND',
        createdAt: now,
        updatedAt: now,
      };
    }

    const existingLastAt = existing.lastMessage?.createdAt?.getTime() ?? 0;
    const isNewer = incomingAt >= existingLastAt;
    const hasUnread =
      message.direction === 'INBOUND' ? true : existing.hasUnread === true;

    return {
      ...existing,
      clientId: message.clientId ?? existing.clientId,
      profileName: message.profileName ?? existing.profileName,
      lastMessage: isNewer ? message : existing.lastMessage,
      messageCount: existing.messageCount + 1,
      hasUnread,
      updatedAt: existing.updatedAt.getTime() >= now.getTime() ? existing.updatedAt : now,
    };
  }

  async upsertFromMessage(message: WhatsAppMessage, organizationId: string): Promise<void> {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, message.phone);
    const docRef = this.db.collection(this.collectionName).doc(id);
    const now = new Date();

    const record = await this.db.runTransaction(async (tx) => {
      recordDocReads();
      const doc = await tx.get(docRef);
      const updated = this.applyMessageToRecord(
        doc.exists ? this.toRecord(doc.data(), id) : undefined,
        message,
        id,
        organizationId,
        now
      );
      recordWrite();
      tx.set(docRef, this.serialize(updated));
      return updated;
    });

    this.upsertInCaches(record);
    if (record.hasUnread) {
      invalidateBadges(organizationId);
    }
  }

  async upsertManyFromMessages(messages: WhatsAppMessage[], organizationId: string): Promise<void> {
    if (messages.length === 0) return;

    const messagesByPhone = new Map<string, WhatsAppMessage[]>();
    for (const message of messages) {
      const list = messagesByPhone.get(message.phone) || [];
      list.push(message);
      messagesByPhone.set(message.phone, list);
    }

    const phones = [...messagesByPhone.keys()];
    const ids = phones.map((phone) =>
      WhatsAppConversationFirestoreRepository.docId(organizationId, phone)
    );
    const docsById = new Map<string, FirebaseFirestore.DocumentSnapshot>();
    const MAX_GET_ALL = 300;
    for (let i = 0; i < ids.length; i += MAX_GET_ALL) {
      const chunk = ids.slice(i, i + MAX_GET_ALL);
      const refs = chunk.map((id) => this.db.collection(this.collectionName).doc(id));
      const docs = await this.db.getAll(...refs);
      docs.forEach((doc, index) => {
        recordDocReads();
        docsById.set(chunk[index], doc);
      });
    }

    const now = new Date();
    const updatedRecords: WhatsAppConversationRecord[] = [];
    for (const [phone, phoneMessages] of messagesByPhone) {
      const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
      const doc = docsById.get(id);
      let record = doc && doc.exists ? this.toRecord(doc.data(), id) : undefined;
      for (const message of phoneMessages) {
        record = this.applyMessageToRecord(record, message, id, organizationId, now);
      }
      if (record) {
        updatedRecords.push(record);
      }
    }

    if (updatedRecords.length === 0) return;

    const maxBatchWrites = 400;
    for (let i = 0; i < updatedRecords.length; i += maxBatchWrites) {
      const chunk = updatedRecords.slice(i, i + maxBatchWrites);
      const batch = this.db.batch();
      chunk.forEach((record) => {
        recordWrite();
        batch.set(this.db.collection(this.collectionName).doc(record.id), this.serialize(record));
      });
      await batch.commit();
    }

    let hasUnread = false;
    for (const record of updatedRecords) {
      this.upsertInCaches(record);
      if (record.hasUnread) {
        hasUnread = true;
      }
    }
    if (hasUnread) {
      invalidateBadges(organizationId);
    }
  }

  /**
   * Marca una conversación como leída (estado compartido de la organización).
   * No toca `updatedAt` para no reordenar el listado por una simple lectura.
   */
  async markRead(organizationId: string, phone: string, readAt: Date = new Date()): Promise<boolean> {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
    const docRef = this.db.collection(this.collectionName).doc(id);
    recordDocReads();
    const doc = await docRef.get();
    if (!doc.exists) {
      return false;
    }

    const record = this.toRecord(doc.data(), id);
    if (record.hasUnread !== true && record.lastReadAt) {
      return true;
    }

    record.hasUnread = false;
    record.lastReadAt = readAt;

    recordWrite();
    await docRef.set(this.serialize(record));
    this.upsertInCaches(record);
    invalidateBadges(organizationId);
    return true;
  }

  /**
   * Cuenta las conversaciones con mensajes entrantes sin leer de la
   * organización. Usa una agregación `count()`: no lee documentos completos.
   */
  async countUnread(organizationId: string): Promise<number> {
    const snapshot = await this.buildQuery([
      ['organizationId', '==', organizationId],
      ['hasUnread', '==', true],
    ])
      .count()
      .get();
    recordAggregation();
    return snapshot.data().count;
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
    recordDocReads();
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

    recordWrite();
    await docRef.set(this.serialize(record));
    this.upsertInCaches(record);
  }

  async deleteByPhone(organizationId: string, phone: string): Promise<void> {
    const id = WhatsAppConversationFirestoreRepository.docId(organizationId, phone);
    recordWrite();
    await this.db.collection(this.collectionName).doc(id).delete();
    this.removeFromCaches(organizationId, phone);
    invalidateBadges(organizationId);
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

  async listByAdminIds(adminIds: string[]): Promise<PushSubscription[]> {
    const unique = [...new Set(adminIds.filter(Boolean))];
    if (unique.length === 0) {
      return [];
    }

    const MAX_IN_FILTER = 30;
    const results: PushSubscription[] = [];
    for (let i = 0; i < unique.length; i += MAX_IN_FILTER) {
      const chunk = unique.slice(i, i + MAX_IN_FILTER);
      const snapshot = await this.buildQuery([['adminId', 'in', chunk]]).get();
      recordQuery();
      recordDocReads(snapshot.size);
      snapshot.docs.forEach((doc) =>
        results.push(this.deserialize({ id: doc.id, ...doc.data() }))
      );
    }
    return results;
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

export class PaymentReportFirestoreRepository extends FirestoreRepository<PaymentReport> {
  constructor() {
    super('paymentReports');
  }

  async findPendingByPeriod(billingPeriodId: string, organizationId?: string): Promise<PaymentReport | undefined> {
    const filters: Array<[string, any]> =
      organizationId !== undefined
        ? [
            ['organizationId', organizationId],
            ['billingPeriodId', billingPeriodId],
            ['status', 'PENDING'],
          ]
        : [
            ['billingPeriodId', billingPeriodId],
            ['status', 'PENDING'],
          ];
    const results = await this.listByFields(filters, 1);
    return results[0];
  }
}

export class OrganizationPlanPaymentReportFirestoreRepository extends FirestoreRepository<OrganizationPlanPaymentReport> {
  constructor() {
    super('organizationPlanPaymentReports');
  }

  async findPendingByOrganization(organizationId: string): Promise<OrganizationPlanPaymentReport | undefined> {
    const results = await this.listByFields(
      [
        ['organizationId', organizationId],
        ['status', 'PENDING'],
      ],
      1
    );
    return results[0];
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
        recordDocReads();
        const doc = await tx.get(lockRef);
        if (doc.exists) {
          const data = doc.data() as { expiresAt?: number } | undefined;
          if (data?.expiresAt && data.expiresAt > now) {
            throw new Error('JOB_LOCKED');
          }
        }
        recordWrite();
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
    recordDocReads();
    const doc = await lockRef.get();
    if (doc.exists && doc.data()?.instanceId === instanceId) {
      recordWrite();
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
export const adminInviteRepository = new AdminInviteFirestoreRepository();
export const refreshTokenSessionRepository = new RefreshTokenSessionFirestoreRepository();
export const schedulerConfigRepository = new SchedulerConfigFirestoreRepository();
export const schedulerLogRepository = new SchedulerLogFirestoreRepository();
export const whatsappMessageRepository = new WhatsAppMessageFirestoreRepository();
export const whatsappConversationRepository = new WhatsAppConversationFirestoreRepository();
export const pushSubscriptionRepository = new PushSubscriptionFirestoreRepository();
export const domainEventRepository = new DomainEventFirestoreRepository();
export const paymentReportRepository = new PaymentReportFirestoreRepository();
export const organizationPlanPaymentReportRepository =
  new OrganizationPlanPaymentReportFirestoreRepository();
export const jobLockRepository = new JobLockFirestoreRepository();
