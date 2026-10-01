import { Router, Request, Response, NextFunction } from 'express';
import {
  billingPeriodRepository,
  subscriptionRepository,
  planRepository,
  clientRepository,
  paymentReportRepository,
  domainEventRepository,
} from '../../infrastructure/repositories';
import { BusinessError } from '../../domain/entities';
import { SubscriptionBusinessService } from '../../domain/subscription-service';
import { applyRadarToSubscription } from '../../infrastructure/subscription-radar';
import { parseDateOnly, isValidDateString, createId } from '../../domain/business-rules';
import { validateReportPaymentMethod } from '../../domain/payment-reports';
import { getAuth, getEffectiveOrganizationId } from '../middleware/tenant';
import { ReviewPaymentReportDto } from '../dto';

const router = Router();
const businessService = new SubscriptionBusinessService();

async function enrichReports(reports: any[], organizationId: string | undefined): Promise<any[]> {
  if (reports.length === 0) return [];
  const [clients, subscriptions, periods] = await Promise.all([
    clientRepository.listByIds(reports.map((r) => r.clientId)),
    subscriptionRepository.listByIds(reports.map((r) => r.subscriptionId)),
    billingPeriodRepository.listByIds(reports.map((r) => r.billingPeriodId)),
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
    const organizationId = getEffectiveOrganizationId(req);
    const status = (req.query.status as string) || 'PENDING';
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    let reports = await paymentReportRepository.listByOrganization(organizationId);
    if (status && status !== 'ALL') {
      reports = reports.filter((r) => r.status === status);
    }
    reports.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = reports.length;
    const paginated = reports.slice(offset, offset + limit);
    const enriched = await enrichReports(paginated, organizationId);

    res.json({
      reports: enriched,
      pagination: { total, limit, offset, hasMore: offset + limit < total },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/count', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
    const pending = organizationId
      ? await paymentReportRepository.listPendingByOrganization(organizationId)
      : await paymentReportRepository.listByField('status', 'PENDING');
    res.json({ pending: pending.length });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = getEffectiveOrganizationId(req);
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
    const organizationId = getEffectiveOrganizationId(req);
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
      const rejected = {
        ...report,
        status: 'REJECTED' as const,
        reviewedAt: new Date(),
        reviewedByUserId: auth.userId,
        reviewNotes,
      };
      await paymentReportRepository.update(rejected);
      try {
        await domainEventRepository.create({
          id: createId(),
          type: 'payment_report.rejected',
          organizationId: report.organizationId,
          actorUserId: auth.userId,
          entity: 'paymentReport',
          entityId: report.id,
          payload: { billingPeriodId: report.billingPeriodId, reason: reviewNotes },
          createdAt: new Date(),
        });
      } catch (eventError) {
        console.error('[DomainEvent] Error registrando payment_report.rejected:', eventError);
      }
      const [enriched] = await enrichReports([rejected], organizationId);
      return res.json({ report: enriched });
    }

    const period = await billingPeriodRepository.getByIdScoped(report.billingPeriodId, organizationId);
    if (!period) {
      throw new BusinessError('PAYMENT_REPORT_INVALID_STATE', 'El período asociado ya no existe.');
    }
    if (period.status === 'PAID') {
      throw new BusinessError('PERIOD_ALREADY_PAID', 'El período ya se encuentra pagado.');
    }

    validateReportPaymentMethod(report.paymentMethod);

    const paidAtRaw = report.paidAt instanceof Date ? report.paidAt : new Date(report.paidAt);
    const paidAtIso = paidAtRaw.toISOString().slice(0, 10);
    if (!isValidDateString(paidAtIso)) {
      throw new BusinessError('PAYMENT_REPORT_INVALID_STATE', 'La fecha del reporte es inválida.');
    }
    const paidAt = parseDateOnly(paidAtIso);

    const updatedPeriod = businessService.applyPaymentToBillingPeriod({
      billingPeriod: period,
      paymentMethod: report.paymentMethod,
      amount: period.amount,
      paidAt,
      notes: report.notes,
    });

    await billingPeriodRepository.update(updatedPeriod);

    try {
      await domainEventRepository.create({
        id: createId(),
        type: 'billing_period.paid',
        organizationId: period.organizationId,
        actorUserId: auth.userId,
        entity: 'billingPeriod',
        entityId: updatedPeriod.id,
        payload: { subscriptionId: period.subscriptionId, amount: period.amount, paymentMethod: report.paymentMethod, viaReport: report.id },
        createdAt: new Date(),
      });
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando billing_period.paid:', eventError);
    }

    const subscription = await subscriptionRepository.getByIdScoped(period.subscriptionId, organizationId);
    let updatedSubscription = subscription;
    let currentPeriod;
    if (subscription) {
      const allPeriods = await billingPeriodRepository.listBySubscriptionId(subscription.id, organizationId);
      const evaluatedSubscription = businessService.evaluateSubscriptionStatus(subscription, allPeriods);
      let periodsForRadar = allPeriods;
      if (subscription.status === 'SUSPENDED' && evaluatedSubscription.status === 'ACTIVE') {
        const plan = await planRepository.getByIdScoped(subscription.planId, organizationId);
        if (!plan) {
          throw new BusinessError('PLAN_NOT_FOUND', 'Plan no encontrado.');
        }
        const generatedPeriod = businessService.generateCurrentPeriod({
          subscription: evaluatedSubscription,
          plan,
          now: new Date(),
        });
        await billingPeriodRepository.create(generatedPeriod);
        currentPeriod = generatedPeriod;
        periodsForRadar = [...allPeriods, generatedPeriod];
      }
      updatedSubscription = applyRadarToSubscription(evaluatedSubscription, periodsForRadar);
      await subscriptionRepository.update(updatedSubscription);
    }

    const approved = {
      ...report,
      status: 'APPROVED' as const,
      reviewedAt: new Date(),
      reviewedByUserId: auth.userId,
      reviewNotes,
    };
    await paymentReportRepository.update(approved);

    try {
      await domainEventRepository.create({
        id: createId(),
        type: 'payment_report.approved',
        organizationId: report.organizationId,
        actorUserId: auth.userId,
        entity: 'paymentReport',
        entityId: report.id,
        payload: { billingPeriodId: report.billingPeriodId, amount: report.amount },
        createdAt: new Date(),
      });
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando payment_report.approved:', eventError);
    }

    const [enriched] = await enrichReports([approved], organizationId);
    res.json({
      report: enriched,
      billingPeriod: updatedPeriod,
      currentPeriod,
      subscription: updatedSubscription
        ? {
            id: updatedSubscription.id,
            status: updatedSubscription.status,
            previousStatus: subscription?.status,
            reactivated: subscription?.status === 'SUSPENDED' && updatedSubscription.status === 'ACTIVE',
          }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
