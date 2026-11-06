import { Router, Request, Response, NextFunction } from 'express';
import {
  billingPeriodRepository,
  subscriptionRepository,
  clientRepository,
  paymentReportRepository,
} from '../../infrastructure/repositories';
import { BusinessError, PaymentReport } from '../../domain/entities';
import {
  applyPeriodPayment,
  subscriptionTransactions,
  SubscriptionTransaction,
} from '../../infrastructure/billing-transactions';
import { parseDateOnly, isValidDateString } from '../../domain/business-rules';
import { validateReportPaymentMethod } from '../../domain/payment-reports';
import { scheduleStatsRecompute } from '../../infrastructure/stats-service';
import { invalidateBadges } from '../../infrastructure/badge-cache';
import { getAuth, requireOrganizationId } from '../middleware/tenant';
import { QueryFilter } from '../../infrastructure/firestore-repository';
import { ReviewPaymentReportDto } from '../dto';

import { parsePagination } from '../validation';

const router = Router();

/** Dentro de la transacción: dos revisiones simultáneas no pueden aplicar el mismo reporte. */
async function assertReportStillPending(
  transaction: SubscriptionTransaction,
  reportId: string
): Promise<void> {
  const current = await transaction.getDocument<PaymentReport>('paymentReports', reportId);
  if (!current) {
    throw new BusinessError('PAYMENT_REPORT_NOT_FOUND', 'Reporte no encontrado.');
  }
  if (current.status !== 'PENDING') {
    throw new BusinessError('PAYMENT_REPORT_ALREADY_REVIEWED', 'Este reporte ya fue revisado.');
  }
}

async function enrichReports(reports: any[], organizationId: string | undefined): Promise<any[]> {
  if (reports.length === 0) return [];
  const [clients, subscriptions, periods] = await Promise.all([
    clientRepository.listByIds(reports.map((r) => r.clientId), organizationId),
    subscriptionRepository.listByIds(reports.map((r) => r.subscriptionId), organizationId),
    billingPeriodRepository.listByIds(reports.map((r) => r.billingPeriodId), organizationId),
  ]);
  const clientsById = new Map(clients.map((c: any) => [c.id, c]));
  const subsById = new Map(subscriptions.map((s: any) => [s.id, s]));
  const periodsById = new Map(periods.map((p: any) => [p.id, p]));
  return reports.map((r) => {
    const client = clientsById.get(r.clientId);
    const subscription = subsById.get(r.subscriptionId);
    const period = periodsById.get(r.billingPeriodId);
    return {
      ...r,
      client: client
        ? { id: client.id, firstName: client.firstName, lastName: client.lastName, dni: client.dni, phone: client.phone }
        : null,
      subscription: subscription
        ? { id: subscription.id, kitNumber: subscription.kitNumber, status: subscription.status }
        : null,
      billingPeriod: period
        ? { id: period.id, periodLabel: period.periodLabel, startDate: period.startDate, endDate: period.endDate, amount: period.amount, status: period.status }
        : null,
    };
  });
}

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const status = (req.query.status as string) || 'PENDING';
    const { limit, offset } = parsePagination(req.query as Record<string, unknown>);
    const cursor = req.query.cursor as string | undefined;

    const filters: QueryFilter[] = [];
    if (status && status !== 'ALL') {
      filters.push(['status', '==', status]);
    }

    const page = await paymentReportRepository.listPage({
      organizationId,
      filters,
      orderBy: 'createdAt',
      direction: 'desc',
      limit,
      offset,
      cursor,
      requireTotal: !cursor,
    });
    const enriched = await enrichReports(page.items, organizationId);

    res.json({
      reports: enriched,
      pagination: {
        total: page.total,
        limit,
        offset,
        hasMore: page.hasMore,
        nextCursor: page.nextCursor,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const pending = await paymentReportRepository.countWhere([
      ['organizationId', '==', organizationId],
      ['status', '==', 'PENDING'],
    ]);
    res.json({ pending });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const report = await paymentReportRepository.getByIdScoped(req.params.id, organizationId);
    if (!report) {
      throw new BusinessError('PAYMENT_REPORT_NOT_FOUND', 'Reporte no encontrado.');
    }
    const [enriched] = await enrichReports([report], organizationId);
    res.json(enriched);
  } catch (err) {
    next(err);
  }
});

router.post('/:id/review', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: ReviewPaymentReportDto = req.body;
    const auth = getAuth(req);
    const organizationId = requireOrganizationId(req);
    const report = await paymentReportRepository.getByIdScoped(req.params.id, organizationId);

    if (!report) {
      throw new BusinessError('PAYMENT_REPORT_NOT_FOUND', 'Reporte no encontrado.');
    }
    if (report.status !== 'PENDING') {
      throw new BusinessError('PAYMENT_REPORT_ALREADY_REVIEWED', 'Este reporte ya fue revisado.');
    }

    const action = dto?.action;
    if (action !== 'approve' && action !== 'reject') {
      throw new BusinessError('INVALID_DATA', 'La acción debe ser approve o reject.');
    }

    const reviewNotes =
      dto?.notes !== undefined && dto?.notes !== null && String(dto.notes).trim() !== ''
        ? String(dto.notes).trim().slice(0, 500)
        : undefined;

    if (action === 'reject') {
      if (!reviewNotes) {
        throw new BusinessError('INVALID_DATA', 'El motivo del rechazo es obligatorio.');
      }
      const rejected = await subscriptionTransactions.run(
        report.subscriptionId,
        organizationId,
        async (transaction) => {
          await assertReportStillPending(transaction, report.id);
          const reviewed: PaymentReport = {
            ...report,
            status: 'REJECTED',
            reviewedAt: new Date(),
            reviewedByUserId: auth.userId,
            reviewNotes,
          };
          transaction.set('paymentReports', reviewed);
          transaction.addEvent({
            type: 'payment_report.rejected',
            organizationId,
            actorUserId: auth.userId,
            entity: 'paymentReport',
            entityId: report.id,
            payload: { billingPeriodId: report.billingPeriodId, reason: reviewNotes },
          });
          return reviewed;
        }
      );
      scheduleStatsRecompute(organizationId);
      invalidateBadges(organizationId);

      const [enriched] = await enrichReports([rejected], organizationId);
      return res.json({ report: enriched });
    }

    validateReportPaymentMethod(report.paymentMethod);

    const paidAtRaw = report.paidAt instanceof Date ? report.paidAt : new Date(report.paidAt);
    const paidAtIso = paidAtRaw.toISOString().slice(0, 10);
    if (!isValidDateString(paidAtIso)) {
      throw new BusinessError('PAYMENT_REPORT_INVALID_STATE', 'La fecha del reporte es inválida.');
    }
    const paidAt = parseDateOnly(paidAtIso);

    const { approved, payment } = await subscriptionTransactions.run(
      report.subscriptionId,
      organizationId,
      async (transaction) => {
        await assertReportStillPending(transaction, report.id);
        const period = transaction.periods.find((item) => item.id === report.billingPeriodId);
        if (!period) {
          throw new BusinessError('PAYMENT_REPORT_INVALID_STATE', 'El período asociado ya no existe.');
        }

        const appliedPayment = await applyPeriodPayment(transaction, {
          period,
          paymentMethod: report.paymentMethod,
          amount: period.amount,
          paidAt,
          notes: report.notes,
          paymentReference: report.notes,
          actorUserId: auth.userId,
          sourceReportId: report.id,
          eventPayload: { viaReport: report.id },
        });

        const reviewed: PaymentReport = {
          ...report,
          status: 'APPROVED',
          reviewedAt: new Date(),
          reviewedByUserId: auth.userId,
          reviewNotes,
        };
        transaction.set('paymentReports', reviewed);
        transaction.addEvent({
          type: 'payment_report.approved',
          organizationId,
          actorUserId: auth.userId,
          entity: 'paymentReport',
          entityId: report.id,
          payload: { billingPeriodId: report.billingPeriodId, amount: report.amount },
        });
        return { approved: reviewed, payment: appliedPayment };
      }
    );
    scheduleStatsRecompute(organizationId);
    invalidateBadges(organizationId);

    const [enriched] = await enrichReports([approved], organizationId);
    res.json({
      report: enriched,
      billingPeriod: payment.billingPeriod,
      currentPeriod: payment.currentPeriod,
      subscription: payment.subscription
        ? {
            id: payment.subscription.id,
            status: payment.subscription.status,
            previousStatus: payment.previousStatus,
            reactivated: payment.previousStatus === 'SUSPENDED' && payment.subscription.status === 'ACTIVE',
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
