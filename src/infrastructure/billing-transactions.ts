import { recordDocReads, recordWrite } from '../api/middleware/request-id';
import {
  BillingPeriod,
  BusinessError,
  DomainEvent,
  Plan,
  Subscription,
  SubscriptionStatus,
} from '../domain/entities';
import { SubscriptionBusinessService } from '../domain/subscription-service';
import { createId } from '../domain/business-rules';
import { FirestoreRepository } from './firestore-repository';
import { applyRadarToSubscription, pickRadarFields } from './subscription-radar';

const businessService = new SubscriptionBusinessService();

/**
 * Estado de una suscripción leído dentro de una transacción. Las escrituras se acumulan y
 * se aplican al terminar `work`, porque Firestore exige leer antes de escribir.
 */
export interface SubscriptionTransaction {
  subscription?: Subscription;
  periods: BillingPeriod[];
  getPlan(planId: string): Promise<Plan | undefined>;
  getDocument<T>(collection: string, id: string): Promise<T | undefined>;
  set(collection: string, document: { id: string }): void;
  addEvent(event: Omit<DomainEvent, 'id' | 'createdAt'>): void;
}

export interface DailyJobChange {
  subscriptionId: string;
  /** Estado que vio el job. Sin valor si el período quedó sin suscripción. */
  expected?: Pick<Subscription, 'status' | 'currentPeriodId' | 'radarUpdatedAt'>;
  subscription?: Subscription;
  overduePeriodIds: string[];
  createdPeriods: BillingPeriod[];
  events: DomainEvent[];
}

export interface AppliedPeriodPayment {
  billingPeriod: BillingPeriod;
  currentPeriod?: BillingPeriod;
  subscription?: Subscription;
  previousStatus?: SubscriptionStatus;
}

function toTime(value?: Date | null): number | undefined {
  return value ? new Date(value).getTime() : undefined;
}

class SubscriptionTransactionRepository extends FirestoreRepository<{ id: string }> {
  constructor() {
    super('subscriptions');
  }

  /**
   * Ejecuta `work` en una transacción que lee la suscripción y todos sus períodos. Firestore
   * la reintenta si esos documentos cambian antes de confirmar, de modo que dos operaciones
   * simultáneas nunca validan contra el mismo estado.
   */
  async run<R>(
    subscriptionId: string,
    organizationId: string,
    work: (context: SubscriptionTransaction) => Promise<R>
  ): Promise<R> {
    const db = this.db;
    return db.runTransaction(async (transaction) => {
      const writes: Array<() => void> = [];
      const read = async <T>(collection: string, id: string): Promise<T | undefined> => {
        const snapshot = await transaction.get(db.collection(collection).doc(id));
        recordDocReads();
        if (!snapshot.exists) return undefined;
        const document = this.deserialize({ id: snapshot.id, ...snapshot.data() }) as unknown as T & {
          organizationId?: string;
        };
        return document.organizationId === organizationId ? document : undefined;
      };

      const subscription = await read<Subscription>('subscriptions', subscriptionId);
      const periodsSnapshot = await transaction.get(
        db
          .collection('billingPeriods')
          .where('organizationId', '==', organizationId)
          .where('subscriptionId', '==', subscriptionId)
      );
      recordDocReads(periodsSnapshot.size);
      const periods = periodsSnapshot.docs.map(
        (doc) => this.deserialize({ id: doc.id, ...doc.data() }) as unknown as BillingPeriod
      );

      const set = (collection: string, document: { id: string }): void => {
        writes.push(() => {
          recordWrite();
          transaction.set(db.collection(collection).doc(document.id), this.serialize(document));
        });
      };

      const result = await work({
        subscription,
        periods,
        getPlan: (planId) => read<Plan>('plans', planId),
        getDocument: read,
        set,
        addEvent: (event) => {
          const domainEvent: DomainEvent = { ...event, id: createId(), createdAt: new Date() };
          set('domainEvents', domainEvent);
        },
      });

      writes.forEach((write) => write());
      return result;
    });
  }

  /**
   * Elimina la suscripción junto con sus períodos y reportes de pago, para que no queden
   * huérfanos ni reportes pendientes que ya no se pueden aprobar.
   */
  async deleteSubscription(subscriptionId: string, organizationId: string, actorUserId: string): Promise<void> {
    const db = this.db;
    const subscriptionRef = db.collection('subscriptions').doc(subscriptionId);
    const related = (collection: string) =>
      db
        .collection(collection)
        .where('organizationId', '==', organizationId)
        .where('subscriptionId', '==', subscriptionId);

    await db.runTransaction(async (transaction) => {
      const subscription = await transaction.get(subscriptionRef);
      recordDocReads();
      if (!subscription.exists || subscription.data()?.organizationId !== organizationId) {
        throw new BusinessError('NOT_FOUND', 'Suscripción no encontrada.');
      }
      const periods = await transaction.get(related('billingPeriods'));
      const reports = await transaction.get(related('paymentReports'));
      recordDocReads(periods.size + reports.size);

      [...periods.docs, ...reports.docs].forEach((doc) => {
        recordWrite();
        transaction.delete(doc.ref);
      });
      recordWrite();
      transaction.delete(subscriptionRef);

      const event: DomainEvent = {
        id: createId(),
        type: 'subscription.deleted',
        organizationId,
        actorUserId,
        entity: 'subscription',
        entityId: subscriptionId,
        payload: {
          kitNumber: subscription.data()?.kitNumber,
          deletedPeriods: periods.size,
          deletedReports: reports.size,
        },
        createdAt: new Date(),
      };
      recordWrite();
      transaction.set(db.collection('domainEvents').doc(event.id), this.serialize(event));
    });
  }

  /**
   * Guarda de forma atómica lo que el job decidió para una suscripción. Si cambió mientras
   * corría (un pago, una edición) no escribe nada: la siguiente ejecución la reevalúa con
   * datos frescos. Solo toca los campos que le corresponden, no el documento completo.
   */
  async applyDailyJobChange(change: DailyJobChange): Promise<'applied' | 'stale'> {
    const db = this.db;
    const subscriptionRef = db.collection('subscriptions').doc(change.subscriptionId);
    const overdueRefs = change.overduePeriodIds.map((id) => db.collection('billingPeriods').doc(id));
    const createdRefs = change.createdPeriods.map((period) =>
      db.collection('billingPeriods').doc(period.id)
    );

    return db.runTransaction(async (transaction) => {
      if (change.expected) {
        const snapshot = await transaction.get(subscriptionRef);
        recordDocReads();
        if (!snapshot.exists) return 'stale';
        const current = this.deserialize({ id: snapshot.id, ...snapshot.data() }) as unknown as Subscription;
        if (
          current.status !== change.expected.status ||
          (current.currentPeriodId ?? null) !== (change.expected.currentPeriodId ?? null) ||
          toTime(current.radarUpdatedAt) !== toTime(change.expected.radarUpdatedAt)
        ) {
          return 'stale';
        }
      }

      const refs = [...overdueRefs, ...createdRefs];
      const snapshots = refs.length > 0 ? await transaction.getAll(...refs) : [];
      recordDocReads(snapshots.length);
      const overdueSnapshots = snapshots.slice(0, overdueRefs.length);
      const createdSnapshots = snapshots.slice(overdueRefs.length);
      if (
        overdueSnapshots.some((snapshot) => !snapshot.exists || snapshot.data()?.status !== 'PENDING') ||
        createdSnapshots.some((snapshot) => snapshot.exists)
      ) {
        return 'stale';
      }

      overdueRefs.forEach((ref) => {
        recordWrite();
        transaction.update(ref, { status: 'OVERDUE' });
      });
      change.createdPeriods.forEach((period, index) => {
        recordWrite();
        transaction.create(createdRefs[index], this.serialize(period));
      });
      if (change.subscription) {
        recordWrite();
        transaction.update(
          subscriptionRef,
          this.serialize({
            status: change.subscription.status,
            suspensionSource: change.subscription.suspensionSource,
            ...pickRadarFields(change.subscription),
          })
        );
      }
      change.events.forEach((event) => {
        recordWrite();
        transaction.set(db.collection('domainEvents').doc(event.id), this.serialize(event));
      });
      return 'applied';
    });
  }
}

export const subscriptionTransactions = new SubscriptionTransactionRepository();

/**
 * Registra el pago de un período y sus efectos: reactivación, período nuevo y radar. Es la
 * única implementación, compartida por el cobro directo y la aprobación de reportes.
 */
export async function applyPeriodPayment(
  context: SubscriptionTransaction,
  params: {
    period: BillingPeriod;
    paymentMethod: string;
    amount: number;
    paidAt: Date;
    notes?: string;
    actorUserId: string;
    eventPayload?: Record<string, unknown>;
  }
): Promise<AppliedPeriodPayment> {
  const { period, paymentMethod, amount, paidAt, notes, actorUserId, eventPayload } = params;
  const billingPeriod = businessService.applyPaymentToBillingPeriod({
    billingPeriod: period,
    paymentMethod,
    amount,
    paidAt,
    notes,
  });
  context.set('billingPeriods', billingPeriod);
  context.addEvent({
    type: 'billing_period.paid',
    organizationId: period.organizationId,
    actorUserId,
    entity: 'billingPeriod',
    entityId: billingPeriod.id,
    payload: { subscriptionId: period.subscriptionId, amount, paymentMethod, ...eventPayload },
  });

  const { subscription } = context;
  if (!subscription) {
    return { billingPeriod };
  }

  const allPeriods = context.periods.map((item) => (item.id === billingPeriod.id ? billingPeriod : item));
  const evaluated = businessService.evaluateSubscriptionStatus(subscription, allPeriods);

  let currentPeriod: BillingPeriod | undefined;
  if (subscription.status === 'SUSPENDED' && evaluated.status === 'ACTIVE') {
    const plan = await context.getPlan(subscription.planId);
    if (!plan) {
      throw new BusinessError('PLAN_NOT_FOUND', 'Plan no encontrado.');
    }
    currentPeriod = businessService.generateReactivationPeriod({
      subscription: evaluated,
      plan,
      periods: allPeriods,
      now: new Date(),
    });
    if (currentPeriod) {
      context.set('billingPeriods', currentPeriod);
    }
  }

  const updated = applyRadarToSubscription(
    evaluated,
    currentPeriod ? [...allPeriods, currentPeriod] : allPeriods
  );
  context.set('subscriptions', updated);

  return {
    billingPeriod,
    currentPeriod,
    subscription: updated,
    previousStatus: subscription.status,
  };
}
