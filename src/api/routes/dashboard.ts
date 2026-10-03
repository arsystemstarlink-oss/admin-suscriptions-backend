import { Router, Request, Response, NextFunction } from 'express';
import {
  clientRepository,
  planRepository,
  subscriptionRepository,
  billingPeriodRepository,
} from '../../infrastructure/repositories';
import { QueryFilter } from '../../infrastructure/firestore-repository';
import { requireOrganizationId } from '../middleware/tenant';
import { BillingPeriod, Client, Subscription } from '../../domain/entities';
import { getOrganizationStats } from '../../infrastructure/stats-service';

const router = Router();

function orgFilters(organizationId: string | undefined): QueryFilter[] {
  return organizationId ? [['organizationId', '==', organizationId]] : [];
}

router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const stats = await getOrganizationStats(organizationId);

    res.json({
      clients: stats.clients,
      plans: stats.plans,
      subscriptions: stats.subscriptions,
      billingPeriods: stats.billingPeriods,
      financial: stats.financial,
      generatedAt: stats.updatedAt,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const org = orgFilters(organizationId);
    const now = new Date();
    const in7Days = new Date(now);
    in7Days.setDate(in7Days.getDate() + 7);

    const [suspendedCount, rawExpiring, rawOverdue] = await Promise.all([
      subscriptionRepository.countWhere([...org, ['status', '==', 'SUSPENDED']]),
      billingPeriodRepository.listWhere(
        [...org, ['endDate', '>', now], ['endDate', '<=', in7Days]],
        { orderBy: 'endDate', direction: 'asc', limit: 50 }
      ),
      billingPeriodRepository.listWhere([...org, ['status', '==', 'OVERDUE']], {
        orderBy: 'endDate',
        direction: 'asc',
        limit: 100,
      }),
    ]);

    const subscriptions = await subscriptionRepository.listByIds(
      [...rawExpiring.map((p) => p.subscriptionId), ...rawOverdue.map((p) => p.subscriptionId)],
      organizationId
    );
    const subsById = new Map<string, Subscription>(subscriptions.map((s) => [s.id, s]));
    const activeSubIds = new Set(
      subscriptions.filter((s) => s.status === 'ACTIVE').map((s) => s.id)
    );

    const clients = await clientRepository.listByIds(
      subscriptions.map((s) => s.clientId),
      organizationId
    );
    const clientsById = new Map<string, Client>(clients.map((c) => [c.id, c]));

    const expiringSoon = rawExpiring.filter(
      (p) =>
        activeSubIds.has(p.subscriptionId) &&
        (p.status === 'PENDING' || p.status === 'PAID')
    );

    const overdueDebt = rawOverdue
      .filter((p) => activeSubIds.has(p.subscriptionId))
      .sort((a, b) => a.endDate.getTime() - b.endDate.getTime());

    const enrichPeriod = (period: BillingPeriod) => {
      const sub = subsById.get(period.subscriptionId);
      const client = sub ? clientsById.get(sub.clientId) : undefined;
      return {
        periodId: period.id,
        periodLabel: period.periodLabel,
        amount: period.amount,
        endDate: period.endDate,
        subscriptionId: sub?.id,
        kitNumber: sub?.kitNumber,
        clientName: client ? `${client.firstName} ${client.lastName}` : undefined,
        clientPhone: client?.phone,
        clientDni: client?.dni,
      };
    };

    const topDebtorsMap = new Map<
      string,
      { clientId: string; totalDebt: number; overdueCount: number; oldestOverdueEnd: Date }
    >();
    for (const period of overdueDebt) {
      const sub = subsById.get(period.subscriptionId);
      if (!sub) continue;
      const existing = topDebtorsMap.get(sub.clientId) || {
        clientId: sub.clientId,
        totalDebt: 0,
        overdueCount: 0,
        oldestOverdueEnd: period.endDate,
      };
      existing.totalDebt += period.amount;
      existing.overdueCount += 1;
      if (period.endDate < existing.oldestOverdueEnd) {
        existing.oldestOverdueEnd = period.endDate;
      }
      topDebtorsMap.set(sub.clientId, existing);
    }

    const topDebtors = Array.from(topDebtorsMap.values())
      .sort((a, b) => {
        if (a.overdueCount !== b.overdueCount) return b.overdueCount - a.overdueCount;
        return a.oldestOverdueEnd.getTime() - b.oldestOverdueEnd.getTime();
      })
      .slice(0, 5)
      .map((debtor) => {
        const client = clientsById.get(debtor.clientId);
        return {
          clientId: debtor.clientId,
          clientName: client ? `${client.firstName} ${client.lastName}` : 'Desconocido',
          clientPhone: client?.phone || '',
          clientDni: client?.dni,
          totalDebt: debtor.totalDebt,
          overdueCount: debtor.overdueCount,
        };
      });

    res.json({
      generatedAt: now,
      expiringSoon: {
        count: expiringSoon.length,
        description: 'Suscripciones ACTIVAS con período por vencer en los próximos 7 días',
        items: expiringSoon.map(enrichPeriod),
      },
      overdueDebt: {
        count: overdueDebt.length,
        description: 'Suscripciones ACTIVAS con períodos vencidos (adeudados)',
        totalAmount: overdueDebt.reduce((sum, p) => sum + p.amount, 0),
        items: overdueDebt.map(enrichPeriod),
      },
      suspended: {
        count: suspendedCount,
        description: 'Suscripciones suspendidas (sin notificaciones)',
      },
      topDebtors: {
        count: topDebtors.length,
        description:
          'Top 5 clientes con más períodos vencidos, del vencido más antiguo al más reciente (solo suscripciones ACTIVAS)',
        items: topDebtors,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
