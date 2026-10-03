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
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const nextMonthStart = new Date(now.getFullYear(), now.getMonth() + 1, 1);

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
  if (typeof timeout.unref === 'function') {
    timeout.unref();
  }
  pendingRecomputes.set(organizationId, timeout);
}

export async function getOrganizationStats(organizationId: string): Promise<OrganizationStats> {
  recordDocReads();
  const doc = await getFirestore().collection(STATS_COLLECTION).doc(organizationId).get();
  if (doc.exists) {
    return doc.data() as OrganizationStats;
  }
  return persistOrganizationStats(organizationId);
}
