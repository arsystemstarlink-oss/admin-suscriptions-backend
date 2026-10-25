import { Router, Request, Response, NextFunction } from 'express';
import {
  organizationRepository,
  userRepository,
  refreshTokenSessionRepository,
  clientRepository,
  planRepository,
  subscriptionRepository,
  billingPeriodRepository,
  paymentReportRepository,
  whatsappMessageRepository,
  pushSubscriptionRepository,
  domainEventRepository,
  schedulerConfigRepository,
} from '../../infrastructure/repositories';
import {
  BusinessError,
  BusinessPlanKey,
  Organization,
  OrganizationPlanPayment,
  OrganizationPlanPaymentMethod,
  OrganizationPlanStatus,
  OrganizationTwilioConfig,
  User,
} from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import {
  assertPlanChangeAllowed,
  getOrganizationBillingDay,
  resolveOrganizationPlanExpiration,
  validateOrganizationAdminLimit,
  validatePlanConfiguration,
  resolveClientLimitForPlan,
  BUSINESS_PLAN_PRICES,
} from '../../domain/business-plan';
import { deleteOrganizationStats } from '../../infrastructure/stats-service';
import { requireSuperAdmin } from '../middleware/auth';
import { getAuth } from '../middleware/tenant';
import { normalizePhoneNumber } from '../../infrastructure/whatsapp-service';
import { admin, syncUserCustomClaims } from '../../infrastructure/firebase';
import { authService } from '../../domain/auth-service';
import { toOrganizationDto } from '../dto/organization';

const router = Router();
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.use(requireSuperAdmin);

function parseTwilioInput(
  input: unknown,
  existing?: OrganizationTwilioConfig
): OrganizationTwilioConfig | undefined {
  if (input === undefined) return existing;
  if (input === null) return undefined;

  const body = input as Record<string, unknown>;
  const merged: OrganizationTwilioConfig = { ...(existing || {}) };

  if (body.accountSid !== undefined) {
    const value = String(body.accountSid || '').trim();
    merged.accountSid = value || undefined;
  }

  if (body.phoneNumber !== undefined) {
    const value = normalizePhoneNumber(String(body.phoneNumber || ''));
    merged.phoneNumber = value || undefined;
  }

  if (body.enabled !== undefined) {
    merged.enabled = Boolean(body.enabled);
  }

  if (body.authToken) {
    merged.authToken = String(body.authToken).trim();
  } else if (body.authToken === null) {
    merged.authToken = undefined;
  }

  if (
    !merged.accountSid &&
    !merged.authToken &&
    !merged.phoneNumber &&
    merged.enabled === undefined
  ) {
    return undefined;
  }

  return merged;
}

function parsePlanDate(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (
    typeof value === 'string' &&
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
  ) {
    throw new BusinessError('INVALID_PLAN_DATE', `${field} debe ser una fecha ISO 8601 UTC.`);
  }
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new BusinessError('INVALID_PLAN_DATE', `${field} debe ser una fecha ISO 8601.`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new BusinessError('INVALID_PLAN_DATE', `${field} debe ser una fecha ISO 8601 válida.`);
  }
  return date;
}

function defaultOrganizationPlan(now = new Date()): Pick<
  Organization,
  'plan' | 'clientLimit' | 'planStatus' | 'billingDay' | 'trialEndsAt' | 'planExpiresAt' | 'clientCount'
> {
  const trialEndsAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  return {
    plan: 'basico',
    clientLimit: 30,
    planStatus: 'prueba',
    billingDay: Math.min(Math.max(now.getUTCDate(), 1), 28),
    trialEndsAt,
    planExpiresAt: null,
    clientCount: 0,
  };
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

async function resolveUniqueSlug(baseSlug: string, excludeId?: string): Promise<string> {
  let candidate = baseSlug;
  let counter = 1;

  while (true) {
    const existing = await organizationRepository.findBySlug(candidate);
    if (!existing || existing.id === excludeId) {
      return candidate;
    }
    counter += 1;
    candidate = `${baseSlug}-${counter}`;
  }
}

async function refreshExpiredOrganizations(organizations: Organization[]): Promise<Organization[]> {
  return Promise.all(
    organizations.map((organization) => organizationRepository.refreshExpiredStatus(organization))
  );
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug, active, twilio } = req.body;

    if (!name || !name.trim()) {
      throw new BusinessError('INVALID_DATA', 'El nombre de la organización es obligatorio.');
    }

    let normalizedSlug: string | undefined;
    const slugProvided = slug !== undefined && slug !== null && slug !== '';

    if (slugProvided) {
      normalizedSlug = slugify(String(slug));
      const existing = await organizationRepository.findBySlug(normalizedSlug);
      if (existing) {
        throw new BusinessError('INVALID_DATA', 'Ya existe una organización con ese slug.');
      }
    } else {
      const baseSlug = slugify(name);
      if (baseSlug) {
        normalizedSlug = await resolveUniqueSlug(baseSlug);
      }
    }

    const actor = getAuth(req);
    const organization: Organization = {
      id: createId(),
      name: name.trim().toUpperCase(),
      slug: normalizedSlug,
      active: active !== undefined ? Boolean(active) : true,
      ...defaultOrganizationPlan(),
      planUpdatedAt: new Date(),
      planUpdatedBy: actor.userId,
      twilio: parseTwilioInput(twilio) ?? { enabled: false },
      createdAt: new Date(),
      createdBy: actor.userId,
    };

    await organizationRepository.createWithTwilioClaim(organization);
    res.status(201).json(toOrganizationDto(organization));
  } catch (err) {
    next(err);
  }
});

router.post('/onboard', async (req: Request, res: Response, next: NextFunction) => {
  let firebaseUserCreated = false;
  let userId: string | undefined;
  try {
    const organizationInput = req.body?.organization;
    const adminInput = req.body?.admin;
    const name = typeof organizationInput?.name === 'string' ? organizationInput.name.trim() : '';
    const adminName = typeof adminInput?.name === 'string' ? adminInput.name.trim() : '';
    const email = typeof adminInput?.email === 'string' ? adminInput.email.trim().toLowerCase() : '';
    const password = typeof adminInput?.password === 'string' ? adminInput.password : '';

    if (!name || !adminName) {
      throw new BusinessError('INVALID_DATA', 'El nombre de la organización y del administrador son obligatorios.');
    }
    if (!EMAIL_REGEX.test(email)) {
      throw new BusinessError('INVALID_EMAIL', 'El email no es válido.');
    }
    if (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
      throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe tener al menos 8 caracteres e incluir letras y números.');
    }

    const actor = getAuth(req);
    const now = new Date();
    const slugValue = typeof organizationInput.slug === 'string' ? organizationInput.slug.trim() : '';
    const normalizedSlug = slugValue
      ? slugify(slugValue)
      : await resolveUniqueSlug(slugify(name));
    if (!normalizedSlug) {
      throw new BusinessError('INVALID_DATA', 'El slug de la organización no es válido.');
    }

    const organization: Organization = {
      id: createId(),
      name: name.toUpperCase(),
      slug: normalizedSlug,
      active: true,
      ...defaultOrganizationPlan(now),
      twilio: parseTwilioInput(organizationInput.twilio) ?? { enabled: false },
      createdAt: now,
      createdBy: actor.userId,
      planUpdatedAt: now,
      planUpdatedBy: actor.userId,
    };
    const user: User = {
      id: createId(),
      name: adminName,
      email,
      password: await authService.hashPassword(password),
      role: 'admin',
      organizationId: organization.id,
      createdAt: now,
    };
    userId = user.id;

    try {
      await admin.auth().createUser({
        uid: user.id,
        email: user.email,
        password,
        displayName: user.name,
      });
      firebaseUserCreated = true;
    } catch (error) {
      if ((error as { code?: string }).code === 'auth/email-already-exists') {
        throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
      }
      throw error;
    }

    await organizationRepository.createWithAdmin(organization, user);
    await syncUserCustomClaims({
      uid: user.id,
      role: user.role,
      organizationId: user.organizationId,
    });
    res.status(201).json({
      organization: toOrganizationDto(organization),
      admin: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        organizationId: user.organizationId,
        createdAt: user.createdAt,
      },
    });
  } catch (err) {
    if (firebaseUserCreated && userId) {
      try {
        await admin.auth().deleteUser(userId);
      } catch (cleanupError) {
        console.error('[Organizations] No se pudo revertir el usuario de Firebase Auth del alta conjunta.', {
          userId,
          error: (cleanupError as Error).message,
        });
      }
    }
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;
    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);
    const cursor = req.query.cursor as string | undefined;
    const filter = req.query.filter as string | undefined;

    if (
      filter !== undefined &&
      filter !== 'trial-expiring' &&
      filter !== 'expired' &&
      filter !== 'near-limit'
    ) {
      throw new BusinessError('INVALID_FILTER', 'El filtro de plan no es válido.');
    }

    if (filter) {
      const now = new Date();
      const trialWindowEnd = now.getTime() + 3 * 24 * 60 * 60 * 1000;
      let organizations = await organizationRepository.list();
      if (search) {
        const searchLower = search.toLowerCase();
        organizations = organizations.filter(
          (organization) =>
            organization.name.toLowerCase().includes(searchLower) ||
            (organization.slug || '').toLowerCase().includes(searchLower)
        );
      }
      organizations = organizations.filter((organization) => {
        if (filter === 'trial-expiring') {
          const end = organization.trialEndsAt?.getTime();
          return organization.planStatus === 'prueba' && end !== undefined && end >= now.getTime() && end <= trialWindowEnd;
        }
        if (filter === 'expired') {
          const trialEnd = organization.trialEndsAt?.getTime();
          const planEnd = organization.planExpiresAt?.getTime();
          return (
            organization.planStatus === 'vencido' ||
            (trialEnd !== undefined && trialEnd <= now.getTime()) ||
            (planEnd !== undefined && planEnd <= now.getTime())
          );
        }
        return (
          Number.isInteger(organization.clientCount) &&
          Number.isInteger(organization.clientLimit) &&
          organization.clientLimit! > 0 &&
          organization.clientCount! / organization.clientLimit! >= 0.8
        );
      });
      organizations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const total = organizations.length;
      const page = await refreshExpiredOrganizations(organizations.slice(offset, offset + limit));
      return res.json({
        organizations: page.map(toOrganizationDto),
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    }

    if (!search) {
        const page = await organizationRepository.listPage({
          limit,
          offset,
          cursor,
          orderBy: 'createdAt',
          direction: 'asc',
          requireTotal: !cursor,
        });
      return res.json({
        organizations: (await refreshExpiredOrganizations(page.items)).map(toOrganizationDto),
        pagination: {
          total: page.total,
          limit,
          offset,
          hasMore: page.hasMore,
          nextCursor: page.nextCursor,
        },
      });
    }

    let organizations = await organizationRepository.list();

    if (search) {
      const searchLower = search.toLowerCase();
      organizations = organizations.filter(
        (o) =>
          o.name.toLowerCase().includes(searchLower) ||
          (o.slug || '').toLowerCase().includes(searchLower)
      );
    }

    organizations.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const total = organizations.length;
    const paginated = await refreshExpiredOrganizations(organizations.slice(offset, offset + limit));

    res.json({
      organizations: paginated.map(toOrganizationDto),
      pagination: {
        total,
        limit,
        offset,
        hasMore: offset + limit < total,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const current = await organizationRepository.getById(req.params.id);
    if (!current) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }
    const organization = await organizationRepository.refreshExpiredStatus(current);

    const users = await userRepository.listByOrganization(organization.id);

    res.json({
      organization: toOrganizationDto(organization),
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        createdAt: u.createdAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug, active, twilio } = req.body;
    const existing = await organizationRepository.getById(req.params.id);

    if (!existing) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

    let normalizedSlug = existing.slug;
    const nameChanged =
      name !== undefined && name.trim() && name.trim().toUpperCase() !== existing.name;

    if (slug !== undefined) {
      normalizedSlug = slugify(String(slug));
      if (!normalizedSlug) {
        throw new BusinessError('INVALID_DATA', 'El slug no puede estar vacío.');
      }
      const existingWithSlug = await organizationRepository.findBySlug(normalizedSlug);
      if (existingWithSlug && existingWithSlug.id !== existing.id) {
        throw new BusinessError('INVALID_DATA', 'Ya existe una organización con ese slug.');
      }
    } else if (nameChanged) {
      const baseSlug = slugify(name);
      if (baseSlug) {
        normalizedSlug = await resolveUniqueSlug(baseSlug, existing.id);
      }
    }

    const plan: BusinessPlanKey =
      req.body.plan === undefined ? existing.plan ?? 'basico' : req.body.plan;
    if (!['basico', 'pro', 'negocio', 'a-medida'].includes(plan)) {
      throw new BusinessError('INVALID_PLAN', 'El plan seleccionado no es válido.');
    }
    const planStatus: OrganizationPlanStatus =
      req.body.planStatus === undefined ? existing.planStatus ?? 'activo' : req.body.planStatus;
    if (!['prueba', 'activo', 'vencido', 'suspendido'].includes(planStatus)) {
      throw new BusinessError('INVALID_PLAN_STATUS', 'El estado del plan no es válido.');
    }

    const parsedTrialEnd = parsePlanDate(req.body.trialEndsAt, 'trialEndsAt');
    const parsedPlanEnd = parsePlanDate(req.body.planExpiresAt, 'planExpiresAt');
    const trialEndsAt =
      planStatus === 'prueba'
        ? parsedTrialEnd === undefined
          ? existing.trialEndsAt ?? null
          : parsedTrialEnd
        : planStatus === 'vencido' || planStatus === 'suspendido'
          ? parsedTrialEnd === undefined
            ? existing.trialEndsAt ?? null
            : parsedTrialEnd
          : null;
    const planExpiresAt =
      planStatus === 'prueba'
        ? null
        : parsedPlanEnd === undefined
          ? existing.planExpiresAt ?? null
          : parsedPlanEnd;
    const clientLimit = resolveClientLimitForPlan(plan, req.body.clientLimit, existing.clientLimit);
    validatePlanConfiguration({
      plan,
      clientLimit: clientLimit!,
      planStatus,
      trialEndsAt,
      planExpiresAt,
    });
    if ((existing.clientCount ?? 0) > clientLimit!) {
      throw new BusinessError(
        'CLIENT_LIMIT_BELOW_USAGE',
        'El límite no puede ser menor que la cantidad actual de clientes.'
      );
    }
    if (existing.plan !== plan || existing.clientLimit !== clientLimit) {
      assertPlanChangeAllowed({
        currentPlanStatus: existing.planStatus,
        currentTrialEndsAt: existing.trialEndsAt,
        currentPlanExpiresAt: existing.planExpiresAt,
        currentClientLimit: existing.clientLimit,
        targetClientLimit: clientLimit,
      });
    }

    const planWasChanged =
      existing.plan !== plan ||
      existing.clientLimit !== clientLimit ||
      existing.planStatus !== planStatus ||
      existing.trialEndsAt?.getTime() !== trialEndsAt?.getTime() ||
      existing.planExpiresAt?.getTime() !== planExpiresAt?.getTime();
    if (existing.plan !== plan) {
      const admins = await userRepository.listByOrganization(existing.id);
      validateOrganizationAdminLimit(
        plan,
        admins.filter((user) => user.role === 'admin').length
      );
    }
    const actor = getAuth(req);
    const updated: Organization = {
      ...existing,
      name: name !== undefined && name.trim() ? name.trim().toUpperCase() : existing.name,
      slug: normalizedSlug,
      active: active !== undefined ? Boolean(active) : existing.active,
      plan,
      clientLimit: clientLimit!,
      planStatus,
      billingDay: getOrganizationBillingDay(existing),
      trialEndsAt,
      planExpiresAt,
      ...(planWasChanged ? { planUpdatedAt: new Date(), planUpdatedBy: actor.userId } : {}),
      twilio: parseTwilioInput(twilio, existing.twilio),
    };

    const saved = await organizationRepository.updateOrganization(updated, existing);
    res.json(toOrganizationDto(await organizationRepository.refreshExpiredStatus(saved)));
  } catch (err) {
    next(err);
  }
});

router.post('/:id/plan-payments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const current = await organizationRepository.getById(req.params.id);
    if (!current) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

    const { paidAt, amount, method, plan, months } = req.body ?? {};
    const parsedPaidAt = parsePlanDate(paidAt, 'paidAt');
    if (!parsedPaidAt) {
      throw new BusinessError('INVALID_PLAN_DATE', 'La fecha de pago es obligatoria.');
    }
    const billingDay = getOrganizationBillingDay(current);
    let newPlanExpiresAt: Date;
    if (months !== undefined) {
      const parsedMonths = typeof months === 'number' ? months : Number(months);
      if (!Number.isInteger(parsedMonths) || parsedMonths < 1 || parsedMonths > 12) {
        throw new BusinessError(
          'INVALID_PLAN_MONTHS',
          'Los meses a renovar deben ser un entero entre 1 y 12.'
        );
      }
      newPlanExpiresAt = resolveOrganizationPlanExpiration({
        paidAt: parsedPaidAt,
        months: parsedMonths,
        billingDay,
        planStatus: current.planStatus,
        trialEndsAt: current.trialEndsAt,
        planExpiresAt: current.planExpiresAt,
      });
    } else {
      const parsedExpiry = parsePlanDate(req.body?.newPlanExpiresAt, 'newPlanExpiresAt');
      if (!parsedExpiry) {
        throw new BusinessError('INVALID_PLAN_DATE', 'Indica los meses a renovar.');
      }
      newPlanExpiresAt = parsedExpiry;
    }
    if (!['transferencia', 'usdt', 'efectivo'].includes(method)) {
      throw new BusinessError('INVALID_PAYMENT_METHOD', 'El método de pago no es válido.');
    }
    if (!['basico', 'pro', 'negocio', 'a-medida'].includes(plan)) {
      throw new BusinessError('INVALID_PLAN', 'El plan seleccionado no es válido.');
    }
    if (
      req.body?.notes !== undefined &&
      (typeof req.body.notes !== 'string' || req.body.notes.length > 1000)
    ) {
      throw new BusinessError('INVALID_DATA', 'Las notas deben ser texto de hasta 1000 caracteres.');
    }

    const paymentPlan = plan as BusinessPlanKey;
    const fixedPrice = BUSINESS_PLAN_PRICES[paymentPlan];
    const effectiveAmount = fixedPrice !== null ? fixedPrice : amount;
    if (
      typeof effectiveAmount !== 'number' ||
      !Number.isFinite(effectiveAmount) ||
      effectiveAmount <= 0
    ) {
      throw new BusinessError('INVALID_PAYMENT_AMOUNT', 'El monto debe ser un número mayor que cero.');
    }
    if (paymentPlan !== current.plan) {
      const admins = await userRepository.listByOrganization(current.id);
      validateOrganizationAdminLimit(
        paymentPlan,
        admins.filter((user) => user.role === 'admin').length
      );
    }
    const clientLimit = resolveClientLimitForPlan(
      paymentPlan,
      req.body?.clientLimit,
      current.clientLimit,
    );
    if (clientLimit < (current.clientCount ?? 0)) {
      throw new BusinessError(
        'CLIENT_LIMIT_BELOW_USAGE',
        'El límite del nuevo plan no puede ser menor que la cantidad actual de clientes.'
      );
    }
    assertPlanChangeAllowed({
      currentPlanStatus: current.planStatus,
      currentTrialEndsAt: current.trialEndsAt,
      currentPlanExpiresAt: current.planExpiresAt,
      currentClientLimit: current.clientLimit,
      targetClientLimit: clientLimit,
    });

    const actor = getAuth(req);
    const payment: OrganizationPlanPayment = {
      id: createId(),
      organizationId: current.id,
      paidAt: parsedPaidAt,
      amount: effectiveAmount,
      method: method as OrganizationPlanPaymentMethod,
      plan: paymentPlan,
      newPlanExpiresAt,
      notes: typeof req.body?.notes === 'string' ? req.body.notes.trim() || undefined : undefined,
      createdBy: actor.userId,
      createdAt: new Date(),
    };
    const organization = await organizationRepository.registerPlanPayment(
      payment,
      paymentPlan,
      clientLimit,
      newPlanExpiresAt,
      billingDay,
    );

    res.status(201).json({ payment, organization: toOrganizationDto(organization) });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const existing = await organizationRepository.getById(req.params.id);
    if (!existing) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

    const orgId = existing.id;

    const users = await userRepository.listByOrganization(orgId);
    await refreshTokenSessionRepository.revokeAllForUsers(users.map((user) => user.id));
    for (const user of users) {
      try {
        await admin.auth().deleteUser(user.id);
      } catch (firebaseError: any) {
        console.warn(
          `[Organizations] No se pudo eliminar de Firebase Auth a ${user.id}:`,
          firebaseError.message
        );
      }
    }

    await userRepository.deleteByFields([['organizationId', orgId]]);
    await clientRepository.deleteByFields([['organizationId', orgId]]);
    await planRepository.deleteByFields([['organizationId', orgId]]);
    await subscriptionRepository.deleteByFields([['organizationId', orgId]]);
    await billingPeriodRepository.deleteByFields([['organizationId', orgId]]);
    await paymentReportRepository.deleteByFields([['organizationId', orgId]]);
    await whatsappMessageRepository.deleteByFields([['organizationId', orgId]]);
    await pushSubscriptionRepository.deleteByFields([['organizationId', orgId]]);
    await domainEventRepository.deleteByFields([['organizationId', orgId]]);
    await schedulerConfigRepository.delete(orgId);

    await deleteOrganizationStats(orgId);
    await organizationRepository.deleteWithTwilioClaim(orgId, existing.twilio?.phoneNumber);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
