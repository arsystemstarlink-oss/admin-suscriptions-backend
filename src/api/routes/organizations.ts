import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import {
  organizationRepository,
  userRepository,
  adminInviteRepository,
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
  AdminInvite,
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
  assertPrepaidMonthsLimit,
  getOrganizationBillingDay,
  resolveOrganizationPlanExpiration,
  resolveOrganizationPlanMonths,
  resolveEffectiveClientLimit,
  validateOrganizationAdminLimit,
  validatePlanConfiguration,
  assertFuturePlanDates,
  resolveClientLimitForPlan,
  resolveFixedPlanPaymentAmount,
} from '../../domain/business-plan';
import { deleteOrganizationStats } from '../../infrastructure/stats-service';
import { requireSuperAdmin } from '../middleware/auth';
import { getAuth } from '../middleware/tenant';
import { normalizePhoneNumber } from '../../infrastructure/whatsapp-service';
import { admin, syncUserCustomClaims } from '../../infrastructure/firebase';
import { authService } from '../../domain/auth-service';
import { toOrganizationDto } from '../dto/organization';
import { parseBusinessPaymentDate } from '../../domain/payment-date';
import { EMAIL_REGEX } from '../../domain/validation';
import {
  defaultOrganizationPlan,
  resolveUniqueSlug,
  slugify,
} from '../lib/organization-setup';

const router = Router();
const TWILIO_ACCOUNT_SID_REGEX = /^AC[0-9a-fA-F]{32}$/;
const E164_REGEX = /^\+[1-9]\d{7,14}$/;
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function generateTemporaryPassword(): string {
  return `${crypto.randomBytes(18).toString('base64url')}a1`;
}

function createInvite(params: {
  userId: string;
  organizationId: string;
  email: string;
  createdBy: string;
  now: Date;
}): { invite: AdminInvite; token: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const invite: AdminInvite = {
    id: createId(),
    tokenHash: authService.hashToken(token),
    userId: params.userId,
    organizationId: params.organizationId,
    email: params.email,
    expiresAt: new Date(params.now.getTime() + INVITE_TTL_MS),
    createdAt: params.now,
    createdBy: params.createdBy,
  };
  return { invite, token };
}

router.use(requireSuperAdmin);

function validateTwilioFormat(config: OrganizationTwilioConfig): void {
  if (config.accountSid && !TWILIO_ACCOUNT_SID_REGEX.test(config.accountSid)) {
    throw new BusinessError(
      'INVALID_TWILIO_CONFIG',
      'El Account SID de Twilio debe empezar por AC y tener 32 caracteres hexadecimales.'
    );
  }
  if (config.authToken && config.authToken.length < 16) {
    throw new BusinessError(
      'INVALID_TWILIO_CONFIG',
      'El Auth Token de Twilio no parece válido.'
    );
  }
  if (config.phoneNumber && !E164_REGEX.test(config.phoneNumber)) {
    throw new BusinessError(
      'INVALID_TWILIO_CONFIG',
      'El número de WhatsApp debe estar en formato E.164, por ejemplo +584223552626.'
    );
  }
  const hasAny = Boolean(config.accountSid || config.authToken || config.phoneNumber);
  if (config.enabled === true) {
    if (!config.accountSid || !config.authToken || !config.phoneNumber) {
      throw new BusinessError(
        'INVALID_TWILIO_CONFIG',
        'Para habilitar WhatsApp debes configurar Account SID, Auth Token y número.'
      );
    }
  } else if (config.enabled === undefined && hasAny && config.accountSid && config.authToken && config.phoneNumber) {
    config.enabled = true;
  }
}

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

  validateTwilioFormat(merged);

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

async function refreshExpiredOrganizations(organizations: Organization[]): Promise<Organization[]> {
  return Promise.all(
    organizations.map((organization) => organizationRepository.refreshExpiredStatus(organization))
  );
}

router.get('/check-slug', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = typeof req.query.slug === 'string' ? req.query.slug : '';
    const normalized = slugify(raw);
    if (!normalized) {
      return res.json({
        slug: null,
        available: false,
        suggestion: null,
        message: 'Escribe un slug con letras o números.',
      });
    }

    const existing = await organizationRepository.findBySlug(normalized);
    if (!existing) {
      return res.json({ slug: normalized, available: true, suggestion: null });
    }

    return res.json({
      slug: normalized,
      available: false,
      suggestion: await resolveUniqueSlug(normalized, existing.id),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug, active, twilio } = req.body;

    if (!name || !name.trim()) {
      throw new BusinessError('INVALID_DATA', 'El nombre de la organización es obligatorio.');
    }

    let normalizedSlug: string | undefined;
    const slugProvided = slug !== undefined && slug !== null && slug !== '';

    if (slugProvided) {
      const baseSlug = slugify(String(slug));
      if (!baseSlug) {
        throw new BusinessError('INVALID_DATA', 'El slug de la organización no es válido.');
      }
      normalizedSlug = await resolveUniqueSlug(baseSlug);
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
    const inviteRequested = adminInput?.invite === true || !password;

    if (!name || !adminName) {
      throw new BusinessError('INVALID_DATA', 'El nombre de la organización y del administrador son obligatorios.');
    }
    if (!EMAIL_REGEX.test(email)) {
      throw new BusinessError('INVALID_EMAIL', 'El email no es válido.');
    }
    if (!inviteRequested && (password.length < 8 || !/[a-zA-Z]/.test(password) || !/\d/.test(password))) {
      throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe tener al menos 8 caracteres e incluir letras y números.');
    }

    const actor = getAuth(req);
    const now = new Date();
    const slugValue = typeof organizationInput.slug === 'string' ? organizationInput.slug.trim() : '';
    const baseSlug = slugValue ? slugify(slugValue) : slugify(name);
    if (slugValue && !baseSlug) {
      throw new BusinessError('INVALID_DATA', 'El slug de la organización no es válido.');
    }
    const normalizedSlug = baseSlug ? await resolveUniqueSlug(baseSlug) : undefined;
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
    const temporaryPassword = inviteRequested ? generateTemporaryPassword() : password;
    const user: User = {
      id: createId(),
      name: adminName,
      email,
      password: await authService.hashPassword(temporaryPassword),
      role: 'admin',
      organizationId: organization.id,
      mustChangePassword: true,
      createdAt: now,
    };
    userId = user.id;

    const inviteData = inviteRequested
      ? createInvite({
          userId: user.id,
          organizationId: organization.id,
          email: user.email,
          createdBy: actor.userId,
          now,
        })
      : undefined;

    try {
      await admin.auth().createUser({
        uid: user.id,
        email: user.email,
        password: temporaryPassword,
        displayName: user.name,
      });
      firebaseUserCreated = true;
    } catch (error) {
      if ((error as { code?: string }).code === 'auth/email-already-exists') {
        throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
      }
      throw error;
    }

    await organizationRepository.createWithAdmin(organization, user, inviteData?.invite);
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
        mustChangePassword: user.mustChangePassword,
        createdAt: user.createdAt,
      },
      ...(inviteData
        ? {
            invite: {
              token: inviteData.token,
              expiresAt: inviteData.invite.expiresAt.toISOString(),
            },
          }
        : {}),
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

router.post('/:id/invitations', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organization = await organizationRepository.getById(req.params.id);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

    const users = await userRepository.listByOrganization(organization.id);
    const requestedUserId = typeof req.body?.userId === 'string' ? req.body.userId : '';
    const adminUser = requestedUserId
      ? users.find((user) => user.id === requestedUserId && user.role === 'admin')
      : users.find((user) => user.role === 'admin');
    if (!adminUser) {
      throw new BusinessError('NOT_FOUND', 'No encontramos un administrador para invitar.');
    }

    const now = new Date();
    const temporaryPassword = generateTemporaryPassword();
    const updatedUser: User = {
      ...adminUser,
      password: await authService.hashPassword(temporaryPassword),
      mustChangePassword: true,
    };

    await userRepository.update(updatedUser);
    await refreshTokenSessionRepository.revokeAllForUser(updatedUser.id);
    await adminInviteRepository.deleteByField('userId', updatedUser.id);

    try {
      await admin.auth().updateUser(updatedUser.id, { password: temporaryPassword });
    } catch (firebaseError: any) {
      console.warn(
        '[Organizations] No se pudo actualizar la contraseña temporal en Firebase Auth:',
        firebaseError.message
      );
    }

    const actor = getAuth(req);
    const { invite, token } = createInvite({
      userId: updatedUser.id,
      organizationId: organization.id,
      email: updatedUser.email,
      createdBy: actor.userId,
      now,
    });
    await adminInviteRepository.create(invite);

    res.status(201).json({
      invite: {
        token,
        expiresAt: invite.expiresAt.toISOString(),
      },
      userId: updatedUser.id,
      email: updatedUser.email,
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
    // El tope vigente se deriva del plan para comparar bajadas contra el espacio real.
    const currentCapacity = resolveEffectiveClientLimit(existing.plan, existing.clientLimit);
    validatePlanConfiguration({
      plan,
      clientLimit: clientLimit!,
      planStatus,
      trialEndsAt,
      planExpiresAt,
    });
    if (planStatus !== existing.planStatus || trialEndsAt !== existing.trialEndsAt || planExpiresAt !== existing.planExpiresAt) {
      assertFuturePlanDates({ planStatus, trialEndsAt, planExpiresAt });
    }
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
        currentClientLimit: currentCapacity ?? existing.clientLimit,
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
    const parsedPaidAt = parseBusinessPaymentDate(paidAt);
    const billingDay = getOrganizationBillingDay(current);
    // El tope vigente se deriva del plan para comparar bajadas contra el espacio real.
    const currentCapacity = resolveEffectiveClientLimit(current.plan, current.clientLimit);
    let newPlanExpiresAt: Date;
    let renewalMonths = 1;
    if (months !== undefined) {
      const parsedMonths = resolveOrganizationPlanMonths(months);
      renewalMonths = parsedMonths;
      newPlanExpiresAt = resolveOrganizationPlanExpiration({
        paidAt: parsedPaidAt,
        months: parsedMonths,
        billingDay,
        planStatus: current.planStatus,
        trialEndsAt: current.trialEndsAt,
        planExpiresAt: current.planExpiresAt,
        currentPlan: current.plan,
        targetPlan: plan as BusinessPlanKey,
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
    assertPrepaidMonthsLimit({ newPlanExpiresAt, billingDay });
    if (
      req.body?.notes !== undefined &&
      (typeof req.body.notes !== 'string' || req.body.notes.length > 1000)
    ) {
      throw new BusinessError('INVALID_DATA', 'Las notas deben ser texto de hasta 1000 caracteres.');
    }

    const paymentPlan = plan as BusinessPlanKey;
    const fixedAmount = resolveFixedPlanPaymentAmount(paymentPlan, renewalMonths);
    const effectiveAmount = fixedAmount !== null ? fixedAmount : amount;
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
      currentClientLimit: currentCapacity ?? current.clientLimit,
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
      months: renewalMonths,
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
