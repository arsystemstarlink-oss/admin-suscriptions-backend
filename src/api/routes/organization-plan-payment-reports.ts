import { Router, Request, Response, NextFunction } from 'express';
import {
  organizationPlanPaymentReportRepository,
  organizationRepository,
  userRepository,
} from '../../infrastructure/repositories';
import {
  BusinessError,
  OrganizationPlanPayment,
  OrganizationPlanPaymentReport,
} from '../../domain/entities';
import { isSuperAdmin } from '../../domain/auth-context';
import { createId } from '../../domain/business-rules';
import {
  BUSINESS_PLAN_ADMIN_LIMITS,
  CUSTOM_PLAN_MIN_CLIENTS,
  MAX_PREPAID_MONTHS,
  addOrganizationBillingMonths,
  assertPlanChangeAllowed,
  assertPrepaidMonthsLimit,
  getOrganizationBillingDay,
  isBusinessPlanKey,
  isOrganizationPlanChange,
  isOrganizationPlanLocked,
  resolveEffectiveClientLimit,
  resolveOrganizationPlanMonths,
  validateOrganizationAdminLimit,
  isOrganizationPlanPaymentMethod,
  resolveClientLimitForPlan,
  resolveFixedPlanPaymentAmount,
  resolveOrganizationPlanExpiration,
} from '../../domain/business-plan';
import { getAuth, requireOrganizationId } from '../middleware/tenant';
import { requireSuperAdmin } from '../middleware/auth';
import { parseBusinessPaymentDate } from '../../domain/payment-date';

const router = Router();

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

    const existingOrganization = await organizationRepository.getById(organizationId);
    if (!existingOrganization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }
    const organization = await organizationRepository.refreshExpiredStatus(existingOrganization);

    const plan = req.body?.plan;
    if (!isBusinessPlanKey(plan)) {
      throw new BusinessError('INVALID_DATA', 'El plan indicado no es válido.');
    }
    const method = req.body?.method;
    if (!isOrganizationPlanPaymentMethod(method)) {
      throw new BusinessError('INVALID_PAYMENT_METHOD', 'Método de pago inválido.');
    }

    const months = resolveOrganizationPlanMonths(req.body?.months);

    const paidAt = parseBusinessPaymentDate(req.body?.paidAt);
    // El tope vigente se deriva del plan, no del valor almacenado, para que el bloqueo de
    // bajadas use siempre el espacio real que concede el contrato actual.
    const currentCapacity = resolveEffectiveClientLimit(
      organization.plan,
      organization.clientLimit
    );
    const clientLimit =
      plan === 'a-medida' && req.body?.clientLimit === undefined
        ? Math.max(
            CUSTOM_PLAN_MIN_CLIENTS,
            currentCapacity ?? 0,
            organization.clientCount ?? 0
          )
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
      currentClientLimit: currentCapacity ?? organization.clientLimit,
      targetClientLimit: clientLimit,
    });
    if (plan !== organization.plan) {
      const admins = await userRepository.listByOrganization(organizationId);
      validateOrganizationAdminLimit(
        plan,
        admins.filter((user) => user.role === 'admin').length
      );
    }

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

router.get('/quote', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const auth = getAuth(req);
    const organizationId = isSuperAdmin(auth)
      ? (req.query.organizationId as string | undefined)
      : requireOrganizationId(req);
    if (!organizationId) {
      throw new BusinessError('TENANT_REQUIRED', 'Indica la organización de la cotización.');
    }

    const existingOrganization = await organizationRepository.getById(organizationId);
    if (!existingOrganization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }
    const organization = await organizationRepository.refreshExpiredStatus(existingOrganization);

    const plan = req.query.plan ?? organization.plan ?? 'basico';
    if (!isBusinessPlanKey(plan)) {
      throw new BusinessError('INVALID_DATA', 'El plan indicado no es válido.');
    }

    const now = new Date();
    const paidAt = req.query.paidAt
      ? parseBusinessPaymentDate(req.query.paidAt, now, { allowFuture: true })
      : now;
    const billingDay = getOrganizationBillingDay(organization, now);
    const maxPlanExpiresAt = addOrganizationBillingMonths(now, MAX_PREPAID_MONTHS, billingDay);
    const planLocked = isOrganizationPlanLocked(organization, now);
    const planChanged = isOrganizationPlanChange({
      currentPlan: organization.plan,
      targetPlan: plan,
      planStatus: organization.planStatus,
    });
    const currentExpiry =
      organization.planStatus === 'prueba'
        ? organization.trialEndsAt
        : organization.planExpiresAt;
    const effectiveClientLimit = resolveEffectiveClientLimit(plan, organization.clientLimit);

    const expirationOptions = Array.from({ length: MAX_PREPAID_MONTHS }, (_, index) => {
      const months = index + 1;
      const newPlanExpiresAt = resolveOrganizationPlanExpiration({
        paidAt,
        months,
        billingDay,
        planStatus: organization.planStatus,
        trialEndsAt: organization.trialEndsAt,
        planExpiresAt: organization.planExpiresAt,
        currentPlan: organization.plan,
        targetPlan: plan,
        now,
      });

      return {
        months,
        newPlanExpiresAt: newPlanExpiresAt.toISOString(),
        exceedsPrepaidLimit: newPlanExpiresAt.getTime() > maxPlanExpiresAt.getTime(),
        amount: resolveFixedPlanPaymentAmount(plan, months),
      };
    });

    res.json({
      quote: {
        organizationId,
        plan,
        billingDay,
        planLocked,
        planChanged,
        clientLimit: effectiveClientLimit,
        clientCount: organization.clientCount ?? null,
        adminLimit: BUSINESS_PLAN_ADMIN_LIMITS[plan],
        extendsCurrent: planLocked && !planChanged && Boolean(currentExpiry),
        currentExpiry: currentExpiry ? currentExpiry.toISOString() : null,
        paidAt: paidAt.toISOString(),
        maxPlanExpiresAt: maxPlanExpiresAt.toISOString(),
        expirations: expirationOptions,
      },
    });
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

    const existingOrganization = await organizationRepository.getById(report.organizationId);
    if (!existingOrganization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }
    const organization = await organizationRepository.refreshExpiredStatus(existingOrganization);
    const currentCapacity = resolveEffectiveClientLimit(
      organization.plan,
      organization.clientLimit
    );

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
      currentClientLimit: currentCapacity ?? organization.clientLimit,
      targetClientLimit: clientLimit,
    });
    if (report.plan !== organization.plan) {
      const admins = await userRepository.listByOrganization(report.organizationId);
      validateOrganizationAdminLimit(
        report.plan,
        admins.filter((user) => user.role === 'admin').length
      );
    }

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
