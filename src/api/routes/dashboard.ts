import { Router, Request, Response, NextFunction } from 'express';
import {
  clientRepository,
  planRepository,
  subscriptionRepository,
  billingPeriodRepository,
} from '../../infrastructure/repositories';
import { getEffectiveOrganizationId } from '../middleware/tenant';

const router = Router();

router.get('/summary', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const [clients, plans, subscriptions, periods] = await Promise.all([
      clientRepository.listByOrganization(organizationId),
      planRepository.listByOrganization(organizationId),
      subscriptionRepository.listByOrganization(organizationId),
      billingPeriodRepository.listByOrganization(organizationId),
    ]);

    const activeSubscriptions = subscriptions.filter((s) => s.status === 'ACTIVE');
    const suspendedSubscriptions = subscriptions.filter((s) => s.status === 'SUSPENDED');

    const paidPeriods = periods.filter((p) => p.status === 'PAID');
    const pendingPeriods = periods.filter((p) => p.status === 'PENDING');
    const overduePeriods = periods.filter((p) => p.status === 'OVERDUE');

    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const currentMonthPeriods = paidPeriods.filter((p) => {
      const paidDate = p.paidAt;
      return paidDate && paidDate.getMonth() === currentMonth && paidDate.getFullYear() === currentYear;
    });

    const monthlyIncome = currentMonthPeriods.reduce((sum, p) => sum + p.amount, 0);
    const totalIncome = paidPeriods.reduce((sum, p) => sum + p.amount, 0);
    const totalPending = pendingPeriods.reduce((sum, p) => sum + p.amount, 0);
    const totalOverdue = overduePeriods.reduce((sum, p) => sum + p.amount, 0);

    res.json({
      clients: {
        total: clients.length,
      },
      plans: {
        total: plans.length,
        active: plans.filter((p) => p.active).length,
      },
      subscriptions: {
        total: subscriptions.length,
        active: activeSubscriptions.length,
        suspended: suspendedSubscriptions.length,
      },
      billingPeriods: {
        total: periods.length,
        paid: paidPeriods.length,
        pending: pendingPeriods.length,
        overdue: overduePeriods.length,
      },
      financial: {
        monthlyIncome,
        totalIncome,
        totalPending,
        totalOverdue,
        totalDebt: totalPending + totalOverdue,
      },
      generatedAt: now,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/alerts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const [subscriptions, periods, clients] = await Promise.all([
      subscriptionRepository.listByOrganization(organizationId),
      billingPeriodRepository.listByOrganization(organizationId),
      clientRepository.listByOrganization(organizationId),
    ]);

    const now = new Date();
    const in7Days = new Date(now);
    in7Days.setDate(in7Days.getDate() + 7);

    const activeSubscriptions = subscriptions.filter((s) => s.status === 'ACTIVE');
    const suspendedSubscriptions = subscriptions.filter((s) => s.status === 'SUSPENDED');

    const activeSubIds = new Set(activeSubscriptions.map((s) => s.id));

    const expiringSoon = periods.filter(
      (p) =>
        activeSubIds.has(p.subscriptionId) &&
        (p.status === 'PENDING' || p.status === 'PAID') &&
        p.endDate > now &&
        p.endDate <= in7Days
    );

    const overdueDebt = periods.filter(
      (p) =>
        activeSubIds.has(p.subscriptionId) &&
        p.status === 'OVERDUE'
    );

    const topDebtorsMap = new Map<string, { clientId: string; totalDebt: number; overdueCount: number }>();
    for (const period of overdueDebt) {
      const sub = subscriptions.find((s) => s.id === period.subscriptionId);
      if (!sub) continue;
      const existing = topDebtorsMap.get(sub.clientId) || { clientId: sub.clientId, totalDebt: 0, overdueCount: 0 };
      existing.totalDebt += period.amount;
      existing.overdueCount += 1;
      topDebtorsMap.set(sub.clientId, existing);
    }

    const topDebtors = Array.from(topDebtorsMap.values())
      .sort((a, b) => b.totalDebt - a.totalDebt)
      .slice(0, 5)
      .map((debtor) => {
        const client = clients.find((c) => c.id === debtor.clientId);
        return {
          clientId: debtor.clientId,
          clientName: client ? `${client.firstName} ${client.lastName}` : 'Desconocido',
          clientPhone: client?.phone || '',
          clientDni: client?.dni,
          totalDebt: debtor.totalDebt,
          overdueCount: debtor.overdueCount,
        };
      });

    const enrichPeriod = async (period: (typeof periods)[number]) => {
      const sub = subscriptions.find((s) => s.id === period.subscriptionId);
      const client = sub ? clients.find((c) => c.id === sub.clientId) : null;
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

    const [expiringSoonEnriched, overdueDebtEnriched] = await Promise.all([
      Promise.all(expiringSoon.map(enrichPeriod)),
      Promise.all(overdueDebt.map(enrichPeriod)),
    ]);

    res.json({
      generatedAt: now,
      expiringSoon: {
        count: expiringSoonEnriched.length,
        description: 'Suscripciones ACTIVAS con período por vencer en los próximos 7 días',
        items: expiringSoonEnriched,
      },
      overdueDebt: {
        count: overdueDebtEnriched.length,
        description: 'Suscripciones ACTIVAS con períodos vencidos (adeudados)',
        totalAmount: overdueDebt.reduce((sum, p) => sum + p.amount, 0),
        items: overdueDebtEnriched,
      },
      suspended: {
        count: suspendedSubscriptions.length,
        description: 'Suscripciones suspendidas (sin notificaciones)',
      },
      topDebtors: {
        count: topDebtors.length,
        description: 'Top 5 clientes con mayor deuda (solo suscripciones ACTIVAS)',
        items: topDebtors,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
