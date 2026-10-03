import { getFirestore } from './firebase';
import {
  clientRepository,
  planRepository,
  subscriptionRepository,
  billingPeriodRepository,
} from './repositories';
import { QueryFilter } from './firestore-repository';
import { OrganizationStats } from '../domain/entities';
import { recordDocReads, recordWrite } from '../api/middleware/request-id';

const STATS_COLLECTION = 'organizationStats';
const RECOMPUTE_DEBOUNCE_MS = Number(process.env.STATS_RECOMPUTE_DEBOUNCE_MS || 2000);

const pendingRecomputes = new Map<string, NodeJS.Timeout>();

function orgFilters(organizationId: string): QueryFilter[] {
  return [['organizationId', '==', organizationId]];
}

export async function computeOrganizationStats(organizationId: string): Promise<OrganizationStats> {
  const org = orgFilters(organizationId);
  const now = new Date();
  // Mes calendario en UTC: los períodos se generan con Date.UTC(billingDay),
  // así monthlyIncome debe cortarse en UTC y no en hora local del servidor.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  const [
    clientsTotal,
    plansTotal,
    plansActive,
    subscriptionsTotal,
    subscriptionsActive,
    subscriptionsSuspended,
    periodsTotal,
    periodsPaid,
    periodsPending,
    periodsOverdue,
    totalIncome,
    totalPending,
    totalOverdue,
    monthlyIncome,
  ] = await Promise.all([
    clientRepository.countWhere(org),
    planRepository.countWhere(org),
    planRepository.countWhere([...org, ['active', '==', true]]),
    subscriptionRepository.countWhere(org),
    subscriptionRepository.countWhere([...org, ['status', '==', 'ACTIVE']]),
    subscriptionRepository.countWhere([...org, ['status', '==', 'SUSPENDED']]),
    billingPeriodRepository.countWhere(org),
    billingPeriodRepository.countWhere([...org, ['status', '==', 'PAID']]),
    billingPeriodRepository.countWhere([...org, ['status', '==', 'PENDING']]),
    billingPeriodRepository.countWhere([...org, ['status', '==', 'OVERDUE']]),
    billingPeriodRepository.sumWhere('amount', [...org, ['status', '==', 'PAID']]),
    billingPeriodRepository.sumWhere('amount', [...org, ['status', '==', 'PENDING']]),
    billingPeriodRepository.sumWhere('amount', [...org, ['status', '==', 'OVERDUE']]),
    billingPeriodRepository.sumWhere('amount', [
      ...org,
      ['status', '==', 'PAID'],
      ['paidAt', '>=', monthStart],
      ['paidAt', '<', nextMonthStart],
    ]),
  ]);

  return {
    organizationId,
    clients: { total: clientsTotal },
    plans: { total: plansTotal, active: plansActive },
    subscriptions: {
      total: subscriptionsTotal,
      active: subscriptionsActive,
      suspended: subscriptionsSuspended,
    },
    billingPeriods: {
      total: periodsTotal,
      paid: periodsPaid,
      pending: periodsPending,
      overdue: periodsOverdue,
    },
    financial: {
      monthlyIncome,
      totalIncome,
      totalPending,
      totalOverdue,
      totalDebt: totalPending + totalOverdue,
    },
    updatedAt: now,
  };
}

export async function persistOrganizationStats(organizationId: string): Promise<OrganizationStats> {
  const stats = await computeOrganizationStats(organizationId);
  recordWrite();
  await getFirestore().collection(STATS_COLLECTION).doc(organizationId).set(stats);
  return stats;
}

export async function deleteOrganizationStats(organizationId: string): Promise<void> {
  recordWrite();
  await getFirestore().collection(STATS_COLLECTION).doc(organizationId).delete();
}

export function scheduleStatsRecompute(organizationId: string): void {
  if (!organizationId) return;
  const existing = pendingRecomputes.get(organizationId);
  if (existing) clearTimeout(existing);

  const timeout = setTimeout(() => {
    pendingRecomputes.delete(organizationId);
    persistOrganizationStats(organizationId).catch((error) =>
      console.error(`[Stats] Error recomputando organizationStats/${organizationId}:`, error)
    );
  }, RECOMPUTE_DEBOUNCE_MS);
  // Sin unref: el debounce debe sobrevivir en el proceso activo. Con unref,
  // un Railway/instancia que solo espera el timer puede salir antes de persistir
  // y dejar organizationStats con drift silencioso.
  pendingRecomputes.set(organizationId, timeout);
}

export function flushStatsRecompute(organizationId: string): Promise<OrganizationStats | undefined> {
  const pending = pendingRecomputes.get(organizationId);
  if (pending) {
    clearTimeout(pending);
    pendingRecomputes.delete(organizationId);
  }
  // Reconciliación a demanda (p. ej. tras el daily job): fuerza el recompute
  // en vez de depender del debounce.
  return persistOrganizationStats(organizationId);
}

function toStatsDate(value: unknown): Date {
  if (value instanceof Date) return new Date(value.getTime());
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  if (value && typeof value === 'object' && typeof (value as { _seconds?: unknown })._seconds === 'number') {
    return new Date((value as { _seconds: number })._seconds * 1000);
  }
  const parsed = new Date(value as string);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function toStatsNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export async function getOrganizationStats(organizationId: string): Promise<OrganizationStats> {
  recordDocReads();
  const doc = await getFirestore().collection(STATS_COLLECTION).doc(organizationId).get();
  if (doc.exists) {
    const data = doc.data() as Partial<OrganizationStats> & { updatedAt?: unknown };
    // Normalizar Timestamps de Firestore a Date para que el contrato JSON sea estable.
    return {
      organizationId,
      clients: { total: toStatsNumber(data.clients?.total) },
      plans: {
        total: toStatsNumber(data.plans?.total),
        active: toStatsNumber(data.plans?.active),
      },
      subscriptions: {
        total: toStatsNumber(data.subscriptions?.total),
        active: toStatsNumber(data.subscriptions?.active),
        suspended: toStatsNumber(data.subscriptions?.suspended),
      },
      billingPeriods: {
        total: toStatsNumber(data.billingPeriods?.total),
        paid: toStatsNumber(data.billingPeriods?.paid),
        pending: toStatsNumber(data.billingPeriods?.pending),
        overdue: toStatsNumber(data.billingPeriods?.overdue),
      },
      financial: {
        monthlyIncome: toStatsNumber(data.financial?.monthlyIncome),
        totalIncome: toStatsNumber(data.financial?.totalIncome),
        totalPending: toStatsNumber(data.financial?.totalPending),
        totalOverdue: toStatsNumber(data.financial?.totalOverdue),
        totalDebt: toStatsNumber(data.financial?.totalDebt),
      },
      updatedAt: toStatsDate(data.updatedAt),
    };
  }
  return persistOrganizationStats(organizationId);
}
