import { Router, Request, Response, NextFunction } from 'express';
import {
  userRepository,
  refreshTokenSessionRepository,
  organizationRepository,
} from '../../infrastructure/repositories';
import { authService } from '../../domain/auth-service';
import { BusinessError, User, UserRole } from '../../domain/entities';
import { admin, syncUserCustomClaims } from '../../infrastructure/firebase';
import { AuthenticatedRequest } from '../middleware/auth';
import { getAuth, getEffectiveOrganizationId } from '../middleware/tenant';
import { isSuperAdmin } from '../../domain/auth-context';
import {
  EMAIL_REGEX,
  normalizePhoneToE164,
  toUserDto,
  validatePasswordStrength,
} from './auth';

const router = Router();

router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;
    const auth = getAuth(req);
    const organizationId = getEffectiveOrganizationId(req);

    if (!search) {
      const page = await userRepository.listPage({
        organizationId,
        limit,
        offset,
        orderBy: 'createdAt',
        direction: 'asc',
      });
      return res.json({
        admins: page.items.map(toUserDto),
        pagination: {
          total: page.total,
          limit,
          offset,
          hasMore: page.hasMore,
        },
      });
    }

    let admins: User[];
    if (isSuperAdmin(auth) && !organizationId) {
      admins = await userRepository.list();
    } else {
      admins = await userRepository.listByOrganization(organizationId || auth.organizationId || '');
    }

    if (search) {
      const searchLower = search.toLowerCase();
      admins = admins.filter(
        (u) =>
          u.name.toLowerCase().includes(searchLower) ||
          u.email.toLowerCase().includes(searchLower) ||
          (u.phone || '').toLowerCase().includes(searchLower)
      );
    }

    admins.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const total = admins.length;
    const paginatedAdmins = admins.slice(offset, offset + limit);

    res.json({
      admins: paginatedAdmins.map(toUserDto),
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
    const auth = getAuth(req);
    const organizationId = getEffectiveOrganizationId(req);
    const user = await userRepository.getByIdScoped(req.params.id, isSuperAdmin(auth) ? organizationId : auth.organizationId ?? undefined);

    if (!user) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
    }

    if (!isSuperAdmin(auth) && user.organizationId !== auth.organizationId) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
    }

    res.json({ admin: toUserDto(user) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = req.params.id;
    const actor = getAuth(req);
    const actorId = actor.userId;
    const { name, email, phone, newPassword, role, organizationId } = req.body;

    const user = await userRepository.getById(targetId);
    if (!user) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
    }

    if (!isSuperAdmin(actor)) {
      if (user.organizationId !== actor.organizationId) {
        throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
      }
      if (user.role === 'super-admin') {
        throw new BusinessError('FORBIDDEN', 'No puedes modificar un super-admin.');
      }
    }

    if (user.role === 'super-admin' && role !== undefined && role !== 'super-admin') {
      throw new BusinessError('FORBIDDEN', 'No se puede degradar a un super-admin.');
    }

    const updates: Partial<User> = {};
    let emailChanged = false;
    let passwordChanged = false;

    if (name !== undefined) {
      const trimmed = typeof name === 'string' ? name.trim() : '';
      if (!trimmed) {
        throw new BusinessError('INVALID_DATA', 'El nombre no puede estar vacío.');
      }
      updates.name = trimmed;
    }

    if (email !== undefined) {
      const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
      if (!EMAIL_REGEX.test(normalizedEmail)) {
        throw new BusinessError('INVALID_EMAIL', 'El email no es válido.');
      }

      if (normalizedEmail !== user.email) {
        const existing = await userRepository.findByEmail(normalizedEmail);
        if (existing && existing.id !== user.id) {
          throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
        }
        updates.email = normalizedEmail;
        emailChanged = true;
      }
    }

    if (phone !== undefined) {
      updates.phone = phone ? normalizePhoneToE164(phone) : undefined;
    }

    if (newPassword !== undefined) {
      const password = typeof newPassword === 'string' ? newPassword : '';
      validatePasswordStrength(password);
      updates.password = await authService.hashPassword(password);
      passwordChanged = true;
    }

    if (role !== undefined && isSuperAdmin(actor)) {
      const nextRole: UserRole = role === 'super-admin' ? 'super-admin' : 'admin';
      updates.role = nextRole;
    }

    if (organizationId !== undefined && isSuperAdmin(actor)) {
      if (organizationId === null || organizationId === '') {
        if (user.role === 'super-admin' || updates.role === 'super-admin') {
          updates.organizationId = null;
        } else {
          throw new BusinessError('TENANT_REQUIRED', 'Un administrador requiere una organización.');
        }
      } else {
        const org = await organizationRepository.getById(organizationId);
        if (!org || !org.active) {
          throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización indicada no existe o está inactiva.');
        }
        updates.organizationId = organizationId;
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new BusinessError('INVALID_DATA', 'No hay campos para actualizar.');
    }

    if (updates.role === 'admin' && !updates.organizationId && user.organizationId === null) {
      throw new BusinessError('TENANT_REQUIRED', 'Al asignar rol admin, debes indicar la organización (organizationId).');
    }

    const updatedUser: User = { ...user, ...updates };
    await userRepository.update(updatedUser);

    try {
      const firebaseUpdates: { email?: string; password?: string } = {};
      if (emailChanged) firebaseUpdates.email = updatedUser.email;
      if (passwordChanged) firebaseUpdates.password = newPassword;
      if (Object.keys(firebaseUpdates).length > 0) {
        await admin.auth().updateUser(targetId, firebaseUpdates);
      }
    } catch (firebaseError: any) {
      console.warn('[Admins] No se pudo actualizar en Firebase Auth:', firebaseError.message);
    }

    if (updatedUser.role !== user.role || updatedUser.organizationId !== user.organizationId) {
      await syncUserCustomClaims({
        uid: updatedUser.id,
        role: updatedUser.role,
        organizationId: updatedUser.organizationId,
      });
    }

    if (emailChanged || passwordChanged || updatedUser.role !== user.role || updatedUser.organizationId !== user.organizationId) {
      await refreshTokenSessionRepository.revokeAllForUser(targetId);
    }

    const responseBody: { admin: ReturnType<typeof toUserDto>; accessToken?: string; refreshToken?: string } = {
      admin: toUserDto(updatedUser),
    };

    if ((emailChanged || passwordChanged || updatedUser.role !== user.role || updatedUser.organizationId !== user.organizationId) && targetId === actorId) {
      responseBody.accessToken = authService.generateAccessToken(updatedUser);
      const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(updatedUser);
      await refreshTokenSessionRepository.create({
        id: jti,
        userId: updatedUser.id,
        tokenHash: authService.hashToken(refreshToken),
        createdAt: new Date(),
        expiresAt,
        lastUsedAt: new Date(),
      });
      responseBody.refreshToken = refreshToken;
    }

    res.json(responseBody);
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = req.params.id;
    const actor = getAuth(req);
    const actorId = actor.userId;

    if (targetId === actorId) {
      throw new BusinessError('CANNOT_DELETE_SELF', 'No puedes eliminar tu propio usuario.');
    }

    const user = await userRepository.getById(targetId);
    if (!user) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
    }

    if (!isSuperAdmin(actor)) {
      if (user.organizationId !== actor.organizationId) {
        throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
      }
      if (user.role === 'super-admin') {
        throw new BusinessError('FORBIDDEN', 'No puedes eliminar un super-admin.');
      }
    } else if (user.role === 'super-admin') {
      throw new BusinessError('FORBIDDEN', 'No puedes eliminar otro super-admin.');
    }

    let adminCount: number;
    if (isSuperAdmin(actor)) {
      const allAdmins = await userRepository.list();
      adminCount = allAdmins.filter((u) => u.role === 'admin').length;
    } else {
      const orgAdmins = await userRepository.listByOrganization(actor.organizationId || '');
      adminCount = orgAdmins.filter((u) => u.role === 'admin').length;
    }

    if (adminCount <= 1) {
      throw new BusinessError('LAST_ADMIN', 'No se puede eliminar el único administrador del sistema.');
    }

    await refreshTokenSessionRepository.revokeAllForUser(targetId);

    try {
      await admin.auth().deleteUser(targetId);
    } catch (firebaseError: any) {
      console.warn('[Admins] No se pudo eliminar de Firebase Auth:', firebaseError.message);
    }

    await userRepository.delete(targetId);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

export default router;
