import { BillingPeriod, BillingPeriodStatus, Subscription } from '../domain/entities';

export interface SubscriptionRadarFields {
  radarRank: number;
  pendingPeriods: number;
  overduePeriods: number;
  hasDebt: boolean;
  nearestPendingDate: Date | null;
  closestOverdueDate: Date | null;
  currentPeriodId: string | null;
  currentPeriodStatus: BillingPeriodStatus | null;
  currentPeriodStartDate: Date | null;
  currentPeriodEndDate: Date | null;
  currentPeriodAmount: number | null;
  totalPeriods: number;
  radarUpdatedAt: Date;
}

export function buildSubscriptionRadarFields(periods: BillingPeriod[]): SubscriptionRadarFields {
  const overdue = periods.filter((period) => period.status === 'OVERDUE');
  const pending = periods.filter((period) => period.status === 'PENDING');

  const currentPeriod = periods.reduce<BillingPeriod | undefined>(
    (latest, period) =>
      !latest || period.startDate.getTime() > latest.startDate.getTime() ? period : latest,
    undefined
  );

  const nearestPendingDate = pending.reduce<Date | null>(
    (nearest, period) =>
      !nearest || period.endDate.getTime() < nearest.getTime() ? period.endDate : nearest,
    null
  );

  const closestOverdueDate = overdue.reduce<Date | null>(
    (closest, period) =>
      !closest || period.endDate.getTime() > closest.getTime() ? period.endDate : closest,
    null
  );

  return {
    radarRank: pending.length > 0 ? 1 : overdue.length > 0 ? 2 : 3,
    pendingPeriods: pending.length,
    overduePeriods: overdue.length,
    hasDebt: overdue.length > 0,
    nearestPendingDate,
    closestOverdueDate,
    currentPeriodId: currentPeriod?.id ?? null,
    currentPeriodStatus: currentPeriod?.status ?? null,
    currentPeriodStartDate: currentPeriod?.startDate ?? null,
    currentPeriodEndDate: currentPeriod?.endDate ?? null,
    currentPeriodAmount: currentPeriod?.amount ?? null,
    totalPeriods: periods.length,
    radarUpdatedAt: new Date(),
  };
}

export function applyRadarToSubscription(
  subscription: Subscription,
  periods: BillingPeriod[]
): Subscription {
  return { ...subscription, ...buildSubscriptionRadarFields(periods) };
}

function toTime(value?: Date | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

export function hasRadarChanged(previous: Subscription, next: Subscription): boolean {
  return (
    previous.radarRank !== next.radarRank ||
    (previous.pendingPeriods ?? 0) !== (next.pendingPeriods ?? 0) ||
    (previous.overduePeriods ?? 0) !== (next.overduePeriods ?? 0) ||
    (previous.hasDebt ?? false) !== (next.hasDebt ?? false) ||
    previous.currentPeriodId !== next.currentPeriodId ||
    previous.currentPeriodStatus !== next.currentPeriodStatus ||
    previous.currentPeriodAmount !== next.currentPeriodAmount ||
    (previous.totalPeriods ?? 0) !== (next.totalPeriods ?? 0) ||
    toTime(previous.nearestPendingDate) !== toTime(next.nearestPendingDate) ||
    toTime(previous.closestOverdueDate) !== toTime(next.closestOverdueDate) ||
    toTime(previous.currentPeriodEndDate) !== toTime(next.currentPeriodEndDate)
  );
}
