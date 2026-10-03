import { Router, Request, Response, NextFunction } from 'express';
import {
  organizationRepository,
  clientRepository,
  subscriptionRepository,
  billingPeriodRepository,
  planRepository,
  paymentReportRepository,
  domainEventRepository,
} from '../../infrastructure/repositories';
import { BusinessError, BillingPeriod } from '../../domain/entities';
import { normalizeDni } from '../../domain/business-rules';
import {
  phonesMatch,
  maskPhone,
  maskEmail,
  validateReportPaymentMethod,
  validateReportPaidAt,
} from '../../domain/payment-reports';
import { createId } from '../../domain/business-rules';
import { PublicLookupDto, CreatePaymentReportDto } from '../dto';

const router = Router();

function notFoundGeneric(): BusinessError {
  return new BusinessError('NOT_FOUND', 'No encontramos registros con esos datos. Verifica e intenta de nuevo.');
}

async function resolveOrgBySlug(slug: string) {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) {
    throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
  }
  const org = await organizationRepository.findBySlug(normalized);
  if (!org || !org.active) {
    throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
  }
  return org;
}

async function resolveClientForLookup(organizationId: string, dniRaw: string, phoneRaw: string) {
  const dni = normalizeDni(String(dniRaw || ''));
  const phone = String(phoneRaw || '').trim();
  if (!dni || !phone) {
    throw notFoundGeneric();
  }
  const clients = await clientRepository.listByOrganizationAndDni(organizationId, dni);
  const client = clients[0];
  if (!client || !client.phone || !phonesMatch(client.phone, phone)) {
    throw notFoundGeneric();
  }
  return client;
}

function toPublicPeriodDto(period: BillingPeriod, pendingPeriodIds: Set<string>) {
  return {
    id: period.id,
    subscriptionId: period.subscriptionId,
    periodLabel: period.periodLabel,
    startDate: period.startDate,
    endDate: period.endDate,
    amount: period.amount,
    status: period.status,
    hasPendingReport: pendingPeriodIds.has(period.id),
    // Detalle de pago (solo presente en periodos PAID): sin datos internos ni createdBy*
    paymentMethod: period.paymentMethod,
    paidAt: period.paidAt,
    reference: period.notes,
  };
}

router.get('/org/:slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const org = await resolveOrgBySlug(req.params.slug);
    res.json({
      organization: { id: org.id, name: org.name, slug: org.slug },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/org/:slug/lookup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: PublicLookupDto = req.body;
    const org = await resolveOrgBySlug(req.params.slug);
    const client = await resolveClientForLookup(org.id, dto?.dni, dto?.phone);

    const subscriptions = await subscriptionRepository.listByClientId(client.id, org.id);
    const subscriptionIds = subscriptions.map((s) => s.id);
    const [allPeriods, allReports] = await Promise.all([
      subscriptionIds.length === 0
        ? Promise.resolve([])
        : billingPeriodRepository.listBySubscriptionIds(subscriptionIds, org.id),
      paymentReportRepository
        .listByFields(
          [
            ['organizationId', org.id],
            ['clientId', client.id],
          ],
          200
        )
        .then((reports) =>
          reports.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        ),
    ]);

    const pendingPeriodIds = new Set(
      allReports.filter((r) => r.status === 'PENDING').map((r) => r.billingPeriodId)
    );

    const plans = await planRepository.listByIds(subscriptions.map((s) => s.planId), org.id);
    const plansById = new Map(plans.map((p) => [p.id, p]));

    const publicPeriods = allPeriods
      .slice()
      .sort((a, b) => b.startDate.getTime() - a.startDate.getTime())
      .map((p) => toPublicPeriodDto(p, pendingPeriodIds));

    const unpaid = allPeriods.filter((p) => p.status === 'PENDING' || p.status === 'OVERDUE');
    const totalDebt = unpaid.reduce((sum, p) => sum + p.amount, 0);
    const pendingVerification = allReports.filter((r) => r.status === 'PENDING');
    const pendingVerificationAmount = pendingVerification.reduce((sum, r) => sum + r.amount, 0);

    res.json({
      organization: { id: org.id, name: org.name, slug: org.slug },
      client: {
        id: client.id,
        firstName: client.firstName,
        lastName: client.lastName,
        dni: client.dni,
        phoneMasked: maskPhone(client.phone),
        emailMasked: maskEmail(client.email),
      },
      subscriptions: subscriptions.map((s) => ({
        id: s.id,
        kitNumber: s.kitNumber,
        accountNumber: s.accountNumber,
        billingDay: s.billingDay,
        status: s.status,
        plan: plansById.get(s.planId)
          ? { id: s.planId, name: plansById.get(s.planId)!.name, price: plansById.get(s.planId)!.price }
          : null,
      })),
      periods: publicPeriods,
      pendingReports: pendingVerification.map((r) => ({
        id: r.id,
        billingPeriodId: r.billingPeriodId,
        amount: r.amount,
        status: r.status,
        createdAt: r.createdAt,
      })),
      totals: {
        totalDebt,
        pendingCount: unpaid.filter((p) => p.status === 'PENDING').length,
        overdueCount: unpaid.filter((p) => p.status === 'OVERDUE').length,
        pendingVerificationCount: pendingVerification.length,
        pendingVerificationAmount,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/org/:slug/reports', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const dto: CreatePaymentReportDto = req.body;
    const org = await resolveOrgBySlug(req.params.slug);
    const client = await resolveClientForLookup(org.id, dto?.dni, dto?.phone);

    if (!dto?.billingPeriodId) {
      throw new BusinessError('INVALID_DATA', 'El período a reportar es obligatorio.');
    }
    validateReportPaymentMethod(String(dto.paymentMethod || ''));

    const period = await billingPeriodRepository.getByIdScoped(dto.billingPeriodId, org.id);
    if (!period) {
      throw notFoundGeneric();
    }

    const subscriptions = await subscriptionRepository.listByClientId(client.id, org.id);
    const ownedSubscriptionIds = new Set(subscriptions.map((s) => s.id));
    if (!ownedSubscriptionIds.has(period.subscriptionId)) {
      throw notFoundGeneric();
    }

    if (period.status === 'PAID') {
      throw new BusinessError('PERIOD_ALREADY_PAID', 'Este período ya fue pagado.');
    }

    const existingPending = await paymentReportRepository.findPendingByPeriod(period.id, org.id);
    if (existingPending) {
      throw new BusinessError(
        'PAYMENT_REPORT_ALREADY_EXISTS',
        'Este período ya tiene un reporte en verificación.'
      );
    }

    const paidAt = validateReportPaidAt(String(dto.paidAt || ''), period.startDate);

    const notes =
      dto.notes !== undefined && dto.notes !== null && String(dto.notes).trim() !== ''
        ? String(dto.notes).trim().slice(0, 500)
        : undefined;

    const report = {
      id: createId(),
      organizationId: org.id,
      clientId: client.id,
      subscriptionId: period.subscriptionId,
      billingPeriodId: period.id,
      amount: period.amount,
      paymentMethod: String(dto.paymentMethod),
      paidAt,
      notes,
      status: 'PENDING' as const,
      createdAt: new Date(),
    };

    await paymentReportRepository.create(report);

    try {
      await domainEventRepository.create({
        id: createId(),
        type: 'payment_report.created',
        organizationId: org.id,
        entity: 'paymentReport',
        entityId: report.id,
        payload: { subscriptionId: period.subscriptionId, billingPeriodId: period.id, amount: period.amount },
        createdAt: new Date(),
      });
    } catch (eventError) {
      console.error('[DomainEvent] Error registrando payment_report.created:', eventError);
    }

    res.status(201).json({
      report: {
        id: report.id,
        billingPeriodId: report.billingPeriodId,
        amount: report.amount,
        paymentMethod: report.paymentMethod,
        paidAt: report.paidAt,
        status: report.status,
        createdAt: report.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
