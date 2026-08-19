import { Router, Request, Response, NextFunction } from 'express';
import {
  organizationRepository,
  userRepository,
} from '../../infrastructure/repositories';
import {
  BusinessError,
  Organization,
  OrganizationTwilioConfig,
} from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import { requireSuperAdmin } from '../middleware/auth';
import { getAuth } from '../middleware/tenant';
import { normalizePhoneNumber } from '../../infrastructure/whatsapp-service';

const router = Router();

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

function toOrganizationDto(organization: Organization) {
  const { twilio, ...rest } = organization;

  return {
    ...rest,
    twilioConfigured: Boolean(
      twilio?.accountSid &&
        twilio?.authToken &&
        twilio?.phoneNumber &&
        twilio.enabled !== false
    ),
    twilio: twilio
      ? {
          accountSid: twilio.accountSid,
          phoneNumber: twilio.phoneNumber,
          enabled: twilio.enabled !== false,
          authTokenSet: Boolean(twilio.authToken),
        }
      : undefined,
  };
}

router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, slug, active, twilio } = req.body;

    if (!name || !name.trim()) {
      throw new BusinessError('INVALID_DATA', 'El nombre de la organización es obligatorio.');
    }

    let normalizedSlug: string | undefined;
    if (slug !== undefined && slug !== null && slug !== '') {
      normalizedSlug = String(slug).trim().toLowerCase().replace(/\s+/g, '-');
      const existing = await organizationRepository.findBySlug(normalizedSlug);
      if (existing) {
        throw new BusinessError('INVALID_DATA', 'Ya existe una organización con ese slug.');
      }
    }

    const actor = getAuth(req);
    const organization: Organization = {
      id: createId(),
      name: name.trim(),
      slug: normalizedSlug,
      active: active !== undefined ? Boolean(active) : true,
      twilio: parseTwilioInput(twilio),
      createdAt: new Date(),
      createdBy: actor.userId,
    };

    await organizationRepository.create(organization);
    res.status(201).json(toOrganizationDto(organization));
  } catch (err) {
    next(err);
  }
});

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    if (!search) {
      const page = await organizationRepository.listPage({
        limit,
        offset,
        orderBy: 'createdAt',
        direction: 'asc',
      });
      return res.json({
        organizations: page.items.map(toOrganizationDto),
        pagination: {
          total: page.total,
          limit,
          offset,
          hasMore: page.hasMore,
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
    const paginated = organizations.slice(offset, offset + limit);

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
    const organization = await organizationRepository.getById(req.params.id);
    if (!organization) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'Organización no encontrada.');
    }

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
    if (slug !== undefined) {
      normalizedSlug = String(slug).trim().toLowerCase().replace(/\s+/g, '-');
      if (!normalizedSlug) {
        throw new BusinessError('INVALID_DATA', 'El slug no puede estar vacío.');
      }
      const existingWithSlug = await organizationRepository.findBySlug(normalizedSlug);
      if (existingWithSlug && existingWithSlug.id !== existing.id) {
        throw new BusinessError('INVALID_DATA', 'Ya existe una organización con ese slug.');
      }
    }

    const updated: Organization = {
      ...existing,
      name: name !== undefined && name.trim() ? name.trim() : existing.name,
      slug: normalizedSlug,
      active: active !== undefined ? Boolean(active) : existing.active,
      twilio: parseTwilioInput(twilio, existing.twilio),
    };

    await organizationRepository.update(updated);
    res.json(toOrganizationDto(updated));
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

    const users = await userRepository.listByOrganization(existing.id);
    if (users.length > 0) {
      throw new BusinessError(
        'INVALID_DATA',
        'No se puede eliminar una organización con usuarios asignados. Desactívala o reasigna los usuarios.'
      );
    }

    await organizationRepository.delete(existing.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
