import { Router, Request, Response, NextFunction } from 'express';
import {
  organizationPlanPaymentReportRepository,
  organizationRepository,
} from '../../infrastructure/repositories';
import {
  BusinessError,
  OrganizationPlanPayment,
  OrganizationPlanPaymentReport,
} from '../../domain/entities';
import { isSuperAdmin } from '../../domain/auth-context';
import { createId } from '../../domain/business-rules';
import {
  assertPlanChangeAllowed,
  assertPrepaidMonthsLimit,
  getOrganizationBillingDay,
  isBusinessPlanKey,
  isOrganizationPlanPaymentMethod,
  resolveClientLimitForPlan,
  resolveFixedPlanPaymentAmount,
  resolveOrganizationPlanExpiration,
} from '../../domain/business-plan';
import { getAuth, requireOrganizationId } from '../middleware/tenant';
import { requireSuperAdmin } from '../middleware/auth';

const router = Router();

function parsePaymentDate(value: unknown): Date {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago es obligatoria.');
  }
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value
  );
  if (Number.isNaN(parsed.getTime())) {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago es inválida.');
  }
  const now = new Date();
  const tomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  if (parsed.getTime() >= tomorrow) {
    throw new BusinessError('INVALID_PAYMENT_DATE', 'La fecha de pago no puede ser futura.');
  }
  return parsed;
}

function optionalText(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function serializeReport(report: OrganizationPlanPaymentReport, organizationName?: string) {
  return {
    ...report,
    organizationName,
  };
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const organizationId = isSuperAdmin(auth)
      ? (req.body?.organizationId as string | undefined) ||
        (req.query.organizationId as string | undefined)
      : requireOrganizationId(req);
    if (!organizationId) {
      throw new BusinessError('TENANT_REQUIRED', 'Indica la organización del pago.');
    }

    const organization = await organizationRepository.getById(organizationId);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

    const plan = req.body?.plan;
    if (!isBusinessPlanKey(plan)) {
      throw new BusinessError('INVALID_DATA', 'El plan indicado no es válido.');
    }
    const method = req.body?.method;
    if (!isOrganizationPlanPaymentMethod(method)) {
      throw new BusinessError('INVALID_PAYMENT_METHOD', 'Método de pago inválido.');
    }

    const months = Number(req.body?.months);
    if (!Number.isInteger(months) || months < 1 || months > 12) {
      throw new BusinessError(
        'INVALID_PLAN_MONTHS',
        'Los meses a renovar deben ser un entero entre 1 y 12.'
      );
    }

    const paidAt = parsePaymentDate(req.body?.paidAt);
    const clientLimit =
      plan === 'a-medida' && req.body?.clientLimit === undefined
        ? Math.max(301, organization.clientLimit ?? 0, organization.clientCount ?? 0)
        : resolveClientLimitForPlan(plan, req.body?.clientLimit, organization.clientLimit);
    if (clientLimit < (organization.clientCount ?? 0)) {
      throw new BusinessError(
        'CLIENT_LIMIT_BELOW_USAGE',
        'El plan seleccionado no cubre la cantidad actual de clientes.'
      );
    }
    assertPlanChangeAllowed({
      currentPlanStatus: organization.planStatus,
      currentTrialEndsAt: organization.trialEndsAt,
      currentPlanExpiresAt: organization.planExpiresAt,
      currentClientLimit: organization.clientLimit,
      targetClientLimit: clientLimit,
    });

    const fixedAmount = resolveFixedPlanPaymentAmount(plan, months);
    const amount = fixedAmount !== null ? fixedAmount : Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BusinessError('INVALID_PAYMENT_AMOUNT', 'El monto del pago debe ser mayor que cero.');
    }

    const previewBillingDay = getOrganizationBillingDay(organization);
    const previewExpiry = resolveOrganizationPlanExpiration({
      paidAt,
      months,
      billingDay: previewBillingDay,
      planStatus: organization.planStatus,
      trialEndsAt: organization.trialEndsAt,
      planExpiresAt: organization.planExpiresAt,
      currentPlan: organization.plan,
      targetPlan: plan,
    });
    assertPrepaidMonthsLimit({
      newPlanExpiresAt: previewExpiry,
      billingDay: previewBillingDay,
    });

    const pending = await organizationPlanPaymentReportRepository.findPendingByOrganization(organizationId);
    if (pending) {
      throw new BusinessError(
        'PLAN_PAYMENT_REPORT_ALREADY_EXISTS',
        'Ya tienes un pago de plan en verificación.'
      );
    }

    const report: OrganizationPlanPaymentReport = {
      id: createId(),
      organizationId,
      plan,
      amount,
      method,
      paidAt,
      months,
      clientLimit,
      reference: optionalText(req.body?.reference, 120),
      notes: optionalText(req.body?.notes, 500),
      status: 'PENDING',
      createdAt: new Date(),
      createdByUserId: auth.userId,
    };

    await organizationPlanPaymentReportRepository.create(report);
    res.status(201).json({ report: serializeReport(report, organization.name) });
  } catch (err) {
    next(err);
  }
});

router.get('/mine', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const reports = await organizationPlanPaymentReportRepository.listByOrganization(organizationId);
    reports.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    res.json({ reports: reports.map((report) => serializeReport(report)) });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.query.status as string) || 'PENDING';
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 200);
    const offset = parseInt(req.query.offset as string, 10) || 0;

    let items: OrganizationPlanPaymentReport[];
    let total: number;
    if (status && status !== 'ALL') {
      const matching = await organizationPlanPaymentReportRepository.listByField('status', status);
      matching.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      total = matching.length;
      items = matching.slice(offset, offset + limit);
    } else {
      const page = await organizationPlanPaymentReportRepository.listPage({
        orderBy: 'createdAt',
        direction: 'desc',
        limit,
        offset,
        requireTotal: true,
      });
      items = page.items;
      total = page.total ?? page.items.length;
    }

    const organizations = await organizationRepository.listByIds(
      items.map((report) => report.organizationId)
    );
    const namesById = new Map(organizations.map((organization) => [organization.id, organization.name]));

    res.json({
      reports: items.map((report) =>
        serializeReport(report, namesById.get(report.organizationId))
      ),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + items.length < total,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/review', requireSuperAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const report = await organizationPlanPaymentReportRepository.getById(req.params.id);
    if (!report) {
      throw new BusinessError('PLAN_PAYMENT_REPORT_NOT_FOUND', 'Reporte de plan no encontrado.');
    }
    if (report.status !== 'PENDING') {
      throw new BusinessError(
        'PLAN_PAYMENT_REPORT_ALREADY_REVIEWED',
        'Este reporte ya fue revisado.'
      );
    }

    const action = req.body?.action;
    if (action !== 'approve' && action !== 'reject') {
      throw new BusinessError('INVALID_DATA', 'La acción debe ser approve o reject.');
    }
    const reviewNotes = optionalText(req.body?.notes, 500);

    if (action === 'reject') {
      if (!reviewNotes) {
        throw new BusinessError('INVALID_DATA', 'El motivo del rechazo es obligatorio.');
      }
      const rejected: OrganizationPlanPaymentReport = {
        ...report,
        status: 'REJECTED',
        reviewedAt: new Date(),
        reviewedByUserId: auth.userId,
        reviewNotes,
      };
      await organizationPlanPaymentReportRepository.update(rejected);
      return res.json({ report: serializeReport(rejected) });
    }

    const organization = await organizationRepository.getById(report.organizationId);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

    const clientLimit = resolveClientLimitForPlan(
      report.plan,
      req.body?.clientLimit ?? report.clientLimit,
      organization.clientLimit
    );
    if (clientLimit < (organization.clientCount ?? 0)) {
      throw new BusinessError(
        'CLIENT_LIMIT_BELOW_USAGE',
        'El plan no cubre la cantidad actual de clientes.'
      );
    }
    assertPlanChangeAllowed({
      currentPlanStatus: organization.planStatus,
      currentTrialEndsAt: organization.trialEndsAt,
      currentPlanExpiresAt: organization.planExpiresAt,
      currentClientLimit: organization.clientLimit,
      targetClientLimit: clientLimit,
    });

    const billingDay = getOrganizationBillingDay(organization);
    const newPlanExpiresAt = resolveOrganizationPlanExpiration({
      paidAt: report.paidAt,
      months: report.months,
      billingDay,
      planStatus: organization.planStatus,
      trialEndsAt: organization.trialEndsAt,
      planExpiresAt: organization.planExpiresAt,
      currentPlan: organization.plan,
      targetPlan: report.plan,
    });
    assertPrepaidMonthsLimit({ newPlanExpiresAt, billingDay });

    const payment: OrganizationPlanPayment = {
      id: createId(),
      organizationId: report.organizationId,
      paidAt: report.paidAt,
      amount: report.amount,
      method: report.method,
      plan: report.plan,
      months: report.months,
      newPlanExpiresAt,
      notes: report.notes,
      createdBy: auth.userId,
      createdAt: new Date(),
    };
    const updatedOrganization = await organizationRepository.registerPlanPayment(
      payment,
      report.plan,
      clientLimit,
      newPlanExpiresAt,
      billingDay
    );

    const approved: OrganizationPlanPaymentReport = {
      ...report,
      clientLimit,
      status: 'APPROVED',
      reviewedAt: new Date(),
      reviewedByUserId: auth.userId,
      reviewNotes,
      appliedPaymentId: payment.id,
    };
    await organizationPlanPaymentReportRepository.update(approved);

    res.json({
      report: serializeReport(approved, organization.name),
      organization: updatedOrganization,
      payment,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
