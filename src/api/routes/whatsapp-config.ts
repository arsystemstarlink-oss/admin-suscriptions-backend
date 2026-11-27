import { Router, Request, Response, NextFunction } from 'express';
import {
  BusinessError,
  Organization,
  OrganizationTwilioConfig,
  OrganizationWhatsAppConfig,
  OrganizationWhatsAppRules,
  OrganizationWhatsAppTemplates,
  WhatsAppMessage,
  WhatsAppMode,
} from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import {
  extractTwilioError,
  getWhatsAppWebhookUrls,
  normalizePhoneNumber,
  resolveTwilioCredentials,
  whatsappService,
} from '../../infrastructure/whatsapp-service';
import {
  organizationRepository,
  platformWhatsAppRepository,
  whatsappConversationRepository,
  whatsappMessageRepository,
} from '../../infrastructure/repositories';
import {
  getWhatsAppConfigurationReadiness,
  PLATFORM_WHATSAPP_ID,
  REMINDER_DAY_OPTIONS,
  resolveWhatsAppMode,
  resolveWhatsAppNotificationConfig,
} from '../../infrastructure/whatsapp-configuration';
import {
  assertPlatformQuotaAvailable,
  getPlatformModeReadiness,
  getPlatformWhatsAppAccount,
  isPlatformSender,
  recordPlatformSend,
  toPlatformSummary,
  toSendingOrganization,
} from '../../infrastructure/whatsapp-platform';
import {
  assertTwilioCredentialsAccepted,
  checkWhatsAppConnection,
  connectInboundWebhook,
  describeWhatsAppError,
  listRecentWhatsAppFailures,
  pickTestTemplate,
  submitMissingTemplates,
  submitTemplateForApproval,
  syncPendingTemplateRequests,
  toTemplatesResponse,
} from '../../infrastructure/whatsapp-setup';
import { isWhatsAppTemplateKey, getPortalBaseUrl, WHATSAPP_TEMPLATE_KEYS } from '../../domain/whatsapp-templates';
import { authenticateAdmin } from '../middleware/auth';
import { requireWritablePlan } from '../middleware/organization-plan-access';
import { requireOrganizationId } from '../middleware/tenant';

const router = Router();

router.use(authenticateAdmin);
router.use(requireWritablePlan);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateTwilioPatch(
  input: unknown,
  existing?: OrganizationTwilioConfig
): OrganizationTwilioConfig {
  if (!isRecord(input)) {
    throw new BusinessError('INVALID_DATA', 'El campo "twilio" debe ser un objeto.');
  }

  const updated: OrganizationTwilioConfig = { ...(existing || {}) };
  for (const key of ['accountSid', 'phoneNumber', 'authToken'] as const) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw !== null && typeof raw !== 'string') {
      throw new BusinessError('INVALID_DATA', `El campo "twilio.${key}" debe ser texto o null.`);
    }
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (key === 'authToken') {
      updated.authToken = value || undefined;
    } else if (key === 'accountSid') {
      updated.accountSid = value || undefined;
    } else {
      const normalized = value ? normalizePhoneNumber(value) : '';
      if (normalized && !/^\+?[1-9]\d{1,14}$/.test(normalized)) {
        throw new BusinessError('INVALID_PHONE', 'El número de WhatsApp de Twilio no es válido.');
      }
      updated.phoneNumber = normalized || undefined;
    }
  }

  if ('enabled' in input) {
    if (typeof input.enabled !== 'boolean') {
      throw new BusinessError('INVALID_DATA', 'El campo "twilio.enabled" debe ser booleano.');
    }
    updated.enabled = input.enabled;
  }

  if (updated.accountSid && !/^AC[0-9a-fA-F]{32}$/.test(updated.accountSid)) {
    throw new BusinessError(
      'INVALID_TWILIO_CONFIG',
      'El Account SID de Twilio debe empezar por AC y tener 32 caracteres hexadecimales.'
    );
  }
  if (updated.authToken && updated.authToken.length < 16) {
    throw new BusinessError('INVALID_TWILIO_CONFIG', 'El Auth Token de Twilio no parece válido.');
  }
  if (updated.phoneNumber && !/^\+[1-9]\d{7,14}$/.test(updated.phoneNumber)) {
    throw new BusinessError(
      'INVALID_TWILIO_CONFIG',
      'El número de WhatsApp debe estar en formato E.164, por ejemplo +584223552626.'
    );
  }

  const complete = Boolean(updated.accountSid && updated.authToken && updated.phoneNumber);
  if (updated.enabled === true && !complete) {
    throw new BusinessError(
      'INVALID_TWILIO_CONFIG',
      'Para habilitar WhatsApp debes configurar Account SID, Auth Token y número.'
    );
  }
  if (updated.enabled === undefined && complete) {
    updated.enabled = true;
  }

  return updated;
}

function validateTemplatesPatch(
  input: unknown,
  existing: OrganizationWhatsAppTemplates
): OrganizationWhatsAppTemplates {
  if (!isRecord(input)) {
    throw new BusinessError('INVALID_DATA', 'El campo "templates" debe ser un objeto.');
  }

  const updated = { ...existing };
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    if (!(key in input)) continue;
    const raw = input[key];
    if (raw !== null && typeof raw !== 'string') {
      throw new BusinessError('INVALID_DATA', `La plantilla "${key}" debe ser texto o null.`);
    }
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value.length > 128) {
      throw new BusinessError('INVALID_DATA', `La plantilla "${key}" excede 128 caracteres.`);
    }
    updated[key] = value || undefined;
  }
  return updated;
}

function validateRulesPatch(
  input: unknown,
  existing: OrganizationWhatsAppRules
): OrganizationWhatsAppRules {
  if (!isRecord(input)) {
    throw new BusinessError('INVALID_DATA', 'El campo "rules" debe ser un objeto.');
  }

  const updated = { ...existing };
  if ('reminderDaysBefore' in input) {
    const days = input.reminderDaysBefore;
    if (
      !Array.isArray(days) ||
      days.some((day) => !REMINDER_DAY_OPTIONS.includes(day))
    ) {
      throw new BusinessError(
        'INVALID_DATA',
        `"rules.reminderDaysBefore" solo admite ${REMINDER_DAY_OPTIONS.join(', ')} días de antelación.`
      );
    }
    if (new Set(days).size !== days.length) {
      throw new BusinessError(
        'INVALID_DATA',
        '"rules.reminderDaysBefore" no puede contener días repetidos.'
      );
    }
    updated.reminderDaysBefore = [...days].sort((a, b) => b - a);
  }

  for (const key of [
    'dueDateWarningEnabled',
    'suspensionNoticeEnabled',
    'overdueReminderEnabled',
    'paymentConfirmationEnabled',
  ] as const) {
    if (!(key in input)) continue;
    const enabled = input[key];
    if (typeof enabled !== 'boolean') {
      throw new BusinessError('INVALID_DATA', `"rules.${key}" debe ser booleano.`);
    }
    updated[key] = enabled;
  }
  return updated;
}

async function toConfigResponse(organization: Organization) {
  const config = resolveWhatsAppNotificationConfig(organization);
  const { authToken, ...safeTwilio } = organization.twilio || {};
  // La propia cuenta de la plataforma no tiene otra cuenta detrás.
  const platform = organization.id === PLATFORM_WHATSAPP_ID ? undefined : await getPlatformWhatsAppAccount();
  const readiness =
    platform && isPlatformSender(organization)
      ? getPlatformModeReadiness(organization, platform)
      : getWhatsAppConfigurationReadiness(organization, config);

  return {
    organizationId: organization.id,
    mode: resolveWhatsAppMode(organization),
    platform: platform ? toPlatformSummary(organization, platform) : null,
    twilio: {
      ...safeTwilio,
      authTokenConfigured: Boolean(authToken),
    },
    rules: config.rules,
    templates: config.templates,
    readiness,
    webhooks: getWhatsAppWebhookUrls(),
    // El botón al portal se construye con estos dos datos; si faltan, el frontend lo avisa.
    portal: {
      slug: organization.slug ?? null,
      url: getPortalBaseUrl() ?? null,
    },
    lastTestAt: config.lastTestAt ?? null,
  };
}

/** Solo un super-admin puede pedir otra organización, así que solo él llega a la cuenta de la plataforma. */
async function requireOrganization(req: Request): Promise<Organization> {
  const organizationId = requireOrganizationId(req);
  if (organizationId === PLATFORM_WHATSAPP_ID) return platformWhatsAppRepository.get();
  const organization = await organizationRepository.getById(organizationId);
  if (!organization) {
    throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización no existe.');
  }
  return organization;
}

function credentialsChanged(
  previous: OrganizationTwilioConfig | undefined,
  next: OrganizationTwilioConfig
): boolean {
  return (
    previous?.accountSid !== next.accountSid ||
    previous?.authToken !== next.authToken ||
    previous?.enabled !== next.enabled
  );
}

/** Una plantilla cambiada a mano deja sin efecto su solicitud: al aprobarse la pisaría. */
function dropReplacedRequests(
  requests: OrganizationWhatsAppConfig['templateRequests'],
  previous: OrganizationWhatsAppTemplates,
  next: OrganizationWhatsAppTemplates
): OrganizationWhatsAppConfig['templateRequests'] {
  if (!requests) return undefined;
  const kept = { ...requests };
  for (const key of WHATSAPP_TEMPLATE_KEYS) {
    if (previous[key] !== next[key]) delete kept[key];
  }
  return kept;
}

router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await toConfigResponse(await requireOrganization(req)));
  } catch (error) {
    next(error);
  }
});

router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isRecord(req.body)) {
      throw new BusinessError('INVALID_DATA', 'El cuerpo de la solicitud debe ser un objeto.');
    }
    const organization = await requireOrganization(req);
    const isPlatformAccount = organization.id === PLATFORM_WHATSAPP_ID;

    const currentConfig = resolveWhatsAppNotificationConfig(organization);
    let twilio = organization.twilio;
    let whatsappNotifications = organization.whatsappNotifications;
    let mode: WhatsAppMode | undefined;
    let hasChanges = false;

    if ('mode' in req.body && !isPlatformAccount) {
      if (req.body.mode !== 'platform' && req.body.mode !== 'own') {
        throw new BusinessError('INVALID_DATA', 'El campo "mode" debe ser "platform" u "own".');
      }
      mode = req.body.mode;
      hasChanges = true;
    }

    if ('twilio' in req.body) {
      twilio = validateTwilioPatch(req.body.twilio, organization.twilio);
      hasChanges = true;
      const credentials = resolveTwilioCredentials({ ...organization, twilio });
      if (credentials && credentialsChanged(organization.twilio, twilio)) {
        await assertTwilioCredentialsAccepted(credentials);
      }
    }

    if ('templates' in req.body || 'rules' in req.body) {
      const templates = 'templates' in req.body
        ? validateTemplatesPatch(req.body.templates, currentConfig.templates)
        : currentConfig.templates;
      const rules = 'rules' in req.body
        ? validateRulesPatch(req.body.rules, currentConfig.rules)
        : currentConfig.rules;
      const templateModes = { ...currentConfig.templateModes };
      if ('templates' in req.body) {
        const submittedTemplates = req.body.templates as Record<string, unknown>;
        for (const key of WHATSAPP_TEMPLATE_KEYS) {
          if (!(key in submittedTemplates)) continue;
          if (templates[key]) {
            templateModes[key] = isPlatformAccount ? 'platform' : 'own';
          } else {
            delete templateModes[key];
          }
        }
      }
      whatsappNotifications = {
        templates,
        rules,
        templateModes,
        templateRequests: dropReplacedRequests(
          currentConfig.templateRequests,
          currentConfig.templates,
          templates
        ),
        ...(currentConfig.lastTestAt ? { lastTestAt: currentConfig.lastTestAt } : {}),
      };
      hasChanges = true;
    }

    if (!hasChanges) {
      throw new BusinessError('INVALID_DATA', 'Indica al menos "mode", "twilio", "templates" o "rules".');
    }

    const updated = isPlatformAccount
      ? await platformWhatsAppRepository.updateWhatsAppConfiguration(organization.id, twilio, whatsappNotifications)
      : await organizationRepository.updateWhatsAppConfiguration(organization.id, twilio, whatsappNotifications, mode);
    res.json(await toConfigResponse(updated));
  } catch (error) {
    next(error);
  }
});

router.get('/config/connection', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await checkWhatsAppConnection(await requireOrganization(req)));
  } catch (error) {
    next(error);
  }
});

router.post('/config/webhooks/connect', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json(await connectInboundWebhook(await requireOrganization(req)));
  } catch (error) {
    next(error);
  }
});

router.get('/config/templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organization = await syncPendingTemplateRequests(await requireOrganization(req));
    res.json(toTemplatesResponse(organization));
  } catch (error) {
    next(error);
  }
});

router.post('/config/templates/submit-missing', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await submitMissingTemplates(await requireOrganization(req));
    res.status(result.submitted.length > 0 ? 201 : 200).json({
      ...toTemplatesResponse(result.organization),
      submitted: result.submitted,
      failed: result.failed,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/config/templates/:key/submit', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { key } = req.params;
    if (!isWhatsAppTemplateKey(key)) {
      throw new BusinessError('INVALID_DATA', 'La plantilla indicada no existe.');
    }
    const organization = await submitTemplateForApproval(
      await requireOrganization(req),
      key,
      req.body?.body
    );
    res.status(201).json(toTemplatesResponse(organization));
  } catch (error) {
    next(error);
  }
});

router.post('/config/test-message', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rawTo = typeof req.body?.to === 'string' ? normalizePhoneNumber(req.body.to) : '';
    const to = rawTo.startsWith('+') ? rawTo : `+${rawTo}`;
    if (!/^\+[1-9]\d{7,14}$/.test(to)) {
      throw new BusinessError('INVALID_PHONE', 'Escribe el número con código de país, por ejemplo +584123456789.');
    }

    const organization = await toSendingOrganization(await requireOrganization(req));
    const usesPlatform = isPlatformSender(organization);
    if (!resolveTwilioCredentials(organization)) {
      throw new BusinessError(
        'WHATSAPP_NOT_CONFIGURED',
        usesPlatform
          ? 'El WhatsApp de la plataforma todavía no está disponible.'
          : 'Conecta primero la cuenta de Twilio de esta organización.'
      );
    }
    assertPlatformQuotaAvailable(organization);
    const template = pickTestTemplate(
      resolveWhatsAppNotificationConfig(organization),
      resolveWhatsAppMode(organization),
      usesPlatform ? organization.name : undefined
    );

    let messageSid: string;
    try {
      messageSid = await whatsappService.sendTemplate(
        { to, templateName: template.contentSid, variables: template.variables },
        organization
      );
    } catch (error) {
      const twilioError = extractTwilioError(error);
      if (!twilioError) throw error;
      throw new BusinessError(
        'TWILIO_ERROR',
        describeWhatsAppError(twilioError.code, twilioError.message),
        { twilioCode: twilioError.code, moreInfo: twilioError.moreInfo }
      );
    }

    const message: WhatsAppMessage = {
      id: createId(),
      organizationId: organization.id,
      phone: to,
      direction: 'OUTBOUND',
      messageSid,
      body: `[Prueba] [Template: ${template.contentSid}] Variables: ${JSON.stringify(template.variables)}`,
      templateName: template.contentSid,
      status: 'SENT',
      createdAt: new Date(),
    };
    await whatsappMessageRepository.create(message);
    await whatsappConversationRepository.upsertFromMessage(message, organization.id).catch((error) => {
      console.error('[WhatsApp] Error actualizando conversación de prueba:', error);
    });

    await recordPlatformSend(organization);

    // Solo sirve para que la configuración recuerde el paso: no debe invalidar una prueba ya enviada.
    const lastTestAt = new Date().toISOString();
    await (organization.id === PLATFORM_WHATSAPP_ID ? platformWhatsAppRepository : organizationRepository)
      .mutateWhatsAppNotifications(organization.id, (current) => ({
        ...resolveWhatsAppNotificationConfig(current),
        lastTestAt,
      }))
      .catch((error) => {
        console.error('[WhatsApp] No se pudo registrar la prueba enviada:', error);
      });

    res.status(201).json({ messageSid, templateKey: template.key });
  } catch (error) {
    next(error);
  }
});

router.get('/config/failures', async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ failures: await listRecentWhatsAppFailures(requireOrganizationId(req)) });
  } catch (error) {
    next(error);
  }
});

export default router;
