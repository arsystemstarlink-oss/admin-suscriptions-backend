import { Router, Request, Response, NextFunction } from 'express';
import {
  organizationRepository,
  clientRepository,
  subscriptionRepository,
  billingPeriodRepository,
  planRepository,
  paymentReportRepository,
  domainEventRepository,
  planQuoteRequestRepository,
} from '../../infrastructure/repositories';
import {
  BusinessError,
  BillingPeriod,
  Organization,
  OrganizationPlanPaymentReport,
  PlanQuoteRequest,
  User,
} from '../../domain/entities';
import { normalizeDni } from '../../domain/business-rules';
import {
  phonesMatch,
  maskPhone,
  maskEmail,
  validateReportPaymentMethod,
  validateReportPaidAt,
} from '../../domain/payment-reports';
import { createId } from '../../domain/business-rules';
import {
  assertPlanChangeAllowed,
  assertPrepaidMonthsLimit,
  getBusinessPlanCatalog,
  resolveClientLimitForPlan,
  resolveFixedPlanPaymentAmount,
  resolveOrganizationPlanExpiration,
  validateOrganizationAdminLimit,
} from '../../domain/business-plan';
import {
  buildPaymentInstructions,
  validatePlanQuoteInput,
  validatePublicSignupInput,
} from '../../domain/public-signup';
import { authService } from '../../domain/auth-service';
import { createRefreshSession } from '../../domain/auth-session';
import { admin, syncUserCustomClaims } from '../../infrastructure/firebase';
import { invalidateBadges } from '../../infrastructure/badge-cache';
import { pushService } from '../../infrastructure/push-service';
import { PublicLookupDto, CreatePaymentReportDto } from '../dto';
import { toOrganizationDto } from '../dto/organization';
import { toAuthenticatedUserDto } from '../dto/user';
import {
  defaultOrganizationPlan,
  resolveUniqueSlug,
  slugify,
} from '../lib/organization-setup';
import {
  createCaptchaVerifier,
  createDniRateLimiter,
  createPublicDniLimiterFromEnv,
} from '../middleware/public-protection';

const router = Router();

router.get('/business-plans', (_req: Request, res: Response) => {
  res.json({ plans: getBusinessPlanCatalog() });
});

// Protección del portal público: límite por cédula con bloqueo progresivo y
// verificación CAPTCHA (Cloudflare Turnstile) cuando TURNSTILE_SECRET_KEY está
// configurada. Ambas se aplican a lookup y reports porque ambos validan
// cédula + teléfono y por tanto servirían como oráculo de fuerza bruta.
const dniRateLimit = createDniRateLimiter(createPublicDniLimiterFromEnv());
const verifyCaptcha = createCaptchaVerifier({ action: 'public_consulta' });

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

router.post('/org/:slug/lookup', dniRateLimit, verifyCaptcha, async (req: Request, res: Response, next: NextFunction) => {
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

router.post('/org/:slug/reports', dniRateLimit, verifyCaptcha, async (req: Request, res: Response, next: NextFunction) => {
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
    invalidateBadges(org.id);

    pushService
      .sendBroadcastToOrganization({
        organizationId: org.id,
        title: 'Nuevo reporte de pago',
        body: [`${client.firstName} ${client.lastName}`, period.periodLabel].filter(Boolean).join(' · '),
        data: { url: '/payment-reports', topic: 'payment-reports' },
      })
      .catch((error) => {
        console.error('[Push] Error notificando reporte de pago:', error);
      });

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

router.get('/payment-instructions', (_req: Request, res: Response) => {
  res.json(buildPaymentInstructions());
});

const signupCaptcha = createCaptchaVerifier({ action: 'public_signup' });

router.post('/signup', signupCaptcha, async (req: Request, res: Response, next: NextFunction) => {
  let firebaseUserCreated = false;
  let firebaseUserId: string | undefined;
  try {
    const input = validatePublicSignupInput(req.body);
    const now = new Date();

    const baseSlug = slugify(input.organizationName);
    if (!baseSlug) {
      throw new BusinessError('INVALID_DATA', 'El nombre de la organización no es válido.');
    }
    const slug = await resolveUniqueSlug(baseSlug);

    const organization: Organization = {
      id: createId(),
      name: input.organizationName.toUpperCase(),
      slug,
      active: true,
      ...defaultOrganizationPlan(now),
      twilio: { enabled: false },
      createdAt: now,
    };
    const user: User = {
      id: createId(),
      name: input.adminName,
      email: input.email,
      password: await authService.hashPassword(input.password),
      role: 'admin',
      organizationId: organization.id,
      phone: input.phone,
      lastLoginAt: now,
      mustChangePassword: false,
      createdAt: now,
    };
    organization.createdBy = user.id;
    organization.planUpdatedAt = now;
    organization.planUpdatedBy = user.id;

    let planReport: OrganizationPlanPaymentReport | undefined;
    if (input.plan !== 'basico' && input.payment) {
      const clientLimit = resolveClientLimitForPlan(input.plan);
      assertPlanChangeAllowed({
        currentPlanStatus: organization.planStatus,
        currentTrialEndsAt: organization.trialEndsAt,
        currentPlanExpiresAt: organization.planExpiresAt,
        currentClientLimit: organization.clientLimit,
        targetClientLimit: clientLimit,
      });
      validateOrganizationAdminLimit(input.plan, 1);

      const amount = resolveFixedPlanPaymentAmount(input.plan, 1);
      if (amount === null) {
        throw new BusinessError('INVALID_PLAN', 'El plan seleccionado no tiene precio fijo.');
      }
      const billingDay = organization.billingDay!;
      const previewExpiry = resolveOrganizationPlanExpiration({
        paidAt: now,
        months: 1,
        billingDay,
        planStatus: organization.planStatus,
        trialEndsAt: organization.trialEndsAt,
        planExpiresAt: organization.planExpiresAt,
        currentPlan: organization.plan,
        targetPlan: input.plan,
        now,
      });
      assertPrepaidMonthsLimit({ newPlanExpiresAt: previewExpiry, billingDay });

      planReport = {
        id: createId(),
        organizationId: organization.id,
        plan: input.plan,
        amount,
        method: input.payment.method,
        paidAt: now,
        months: 1,
        clientLimit,
        reference: input.payment.reference,
        notes: input.payment.notes,
        status: 'PENDING',
        createdAt: now,
        createdByUserId: user.id,
      };
    }

    try {
      await admin.auth().createUser({
        uid: user.id,
        email: user.email,
        password: input.password,
        displayName: user.name,
      });
      firebaseUserCreated = true;
      firebaseUserId = user.id;
    } catch (error) {
      if ((error as { code?: string }).code === 'auth/email-already-exists') {
        throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
      }
      throw error;
    }

    try {
      await organizationRepository.createWithAdmin(organization, user, undefined, planReport);
    } catch (error) {
      throw error;
    }

    await syncUserCustomClaims({
      uid: user.id,
      role: user.role,
      organizationId: user.organizationId,
    });

    const accessToken = authService.generateAccessToken(user);
    const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(user, {
      rememberMe: false,
    });
    await createRefreshSession(user, refreshToken, jti, expiresAt, false);

    res.status(201).json({
      accessToken,
      refreshToken,
      user: await toAuthenticatedUserDto(user),
      organization: toOrganizationDto(organization),
      ...(planReport ? { paymentReport: planReport } : {}),
    });
  } catch (err) {
    if (firebaseUserCreated && firebaseUserId) {
      try {
        await admin.auth().deleteUser(firebaseUserId);
      } catch (cleanupError) {
        console.error('[PublicSignup] No se pudo revertir el usuario de Firebase Auth.', {
          userId: firebaseUserId,
          error: (cleanupError as Error).message,
        });
      }
    }
    next(err);
  }
});

const quoteCaptcha = createCaptchaVerifier({ action: 'public_quote' });

router.post(
  '/plan-quote-requests',
  quoteCaptcha,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = validatePlanQuoteInput(req.body);
      const now = new Date();
      const request: PlanQuoteRequest = {
        id: createId(),
        name: input.name,
        email: input.email,
        phone: input.phone,
        organizationName: input.organizationName,
        estimatedClients: input.estimatedClients,
        message: input.message,
        status: 'NEW',
        createdAt: now,
        updatedAt: now,
      };
      await planQuoteRequestRepository.create(request);
      res.status(201).json({ request: { id: request.id, createdAt: request.createdAt } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
