import { Router, Request, Response, NextFunction } from 'express';
import {
  BusinessError,
  Organization,
  OrganizationTwilioConfig,
  OrganizationWhatsAppRules,
  OrganizationWhatsAppTemplates,
} from '../../domain/entities';
import { normalizePhoneNumber } from '../../infrastructure/whatsapp-service';
import { organizationRepository } from '../../infrastructure/repositories';
import {
  getWhatsAppConfigurationReadiness,
  resolveWhatsAppNotificationConfig,
} from '../../infrastructure/whatsapp-configuration';
import { authenticateAdmin } from '../middleware/auth';
import { requireOrganizationId } from '../middleware/tenant';

const router = Router();

router.use(authenticateAdmin);

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
  for (const key of ['reminder', 'dueDateWarning', 'suspensionNotice'] as const) {
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
      days.some((day) => !Number.isInteger(day) || day < 1 || day > 30)
    ) {
      throw new BusinessError(
        'INVALID_DATA',
        '"rules.reminderDaysBefore" debe ser una lista de enteros únicos entre 1 y 30.'
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

  for (const key of ['dueDateWarningEnabled', 'suspensionNoticeEnabled'] as const) {
    if (!(key in input)) continue;
    const enabled = input[key];
    if (typeof enabled !== 'boolean') {
      throw new BusinessError('INVALID_DATA', `"rules.${key}" debe ser booleano.`);
    }
    if (key === 'dueDateWarningEnabled') {
      updated.dueDateWarningEnabled = enabled;
    } else {
      updated.suspensionNoticeEnabled = enabled;
    }
  }
  return updated;
}

function toConfigResponse(organization: Organization) {
  const config = resolveWhatsAppNotificationConfig(organization);
  const readiness = getWhatsAppConfigurationReadiness(organization, config);
  const { authToken, ...safeTwilio } = organization.twilio || {};

  return {
    organizationId: organization.id,
    twilio: {
      ...safeTwilio,
      authTokenConfigured: Boolean(authToken),
    },
    rules: config.rules,
    templates: config.templates,
    readiness,
  };
}

router.get('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const organizationId = requireOrganizationId(req);
    const organization = await organizationRepository.getById(organizationId);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización no existe.');
    }
    res.json(toConfigResponse(organization));
  } catch (error) {
    next(error);
  }
});

router.put('/config', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!isRecord(req.body)) {
      throw new BusinessError('INVALID_DATA', 'El cuerpo de la solicitud debe ser un objeto.');
    }
    const organizationId = requireOrganizationId(req);
    const organization = await organizationRepository.getById(organizationId);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización no existe.');
    }

    const currentConfig = resolveWhatsAppNotificationConfig(organization);
    const updated: Organization = { ...organization };
    let hasChanges = false;

    if ('twilio' in req.body) {
      updated.twilio = validateTwilioPatch(req.body.twilio, organization.twilio);
      hasChanges = true;
    }

    if ('templates' in req.body || 'rules' in req.body) {
      const templates = 'templates' in req.body
        ? validateTemplatesPatch(req.body.templates, currentConfig.templates)
        : currentConfig.templates;
      const rules = 'rules' in req.body
        ? validateRulesPatch(req.body.rules, currentConfig.rules)
        : currentConfig.rules;
      updated.whatsappNotifications = { templates, rules };
      hasChanges = true;
    }

    if (!hasChanges) {
      throw new BusinessError('INVALID_DATA', 'Indica al menos "twilio", "templates" o "rules".');
    }

    await organizationRepository.updateOrganization(updated);
    res.json(toConfigResponse(updated));
  } catch (error) {
    next(error);
  }
});

export default router;
