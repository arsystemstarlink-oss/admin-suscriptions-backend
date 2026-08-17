import { Router, Request, Response, NextFunction } from 'express';
import {
  userRepository,
  refreshTokenSessionRepository,
} from '../../infrastructure/repositories';
import { authService } from '../../domain/auth-service';
import { BusinessError, User } from '../../domain/entities';
import { admin } from '../../infrastructure/firebase';
import { authenticateAdmin, AuthenticatedRequest } from '../middleware/auth';
import {
  EMAIL_REGEX,
  normalizePhoneToE164,
  toUserDto,
  validatePasswordStrength,
} from './auth';

const router = Router();

router.get('/', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const search = req.query.search as string;
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    let admins = await userRepository.list();

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

router.get('/:id', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await userRepository.getById(req.params.id);
    if (!user) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
    }

    res.json({ admin: toUserDto(user) });
  } catch (err) {
    next(err);
  }
});

router.put('/:id', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = req.params.id;
    const actorId = (req as AuthenticatedRequest).user!.userId;
    const { name, email, phone, newPassword } = req.body;

    const user = await userRepository.getById(targetId);
    if (!user) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
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

    if (Object.keys(updates).length === 0) {
      throw new BusinessError('INVALID_DATA', 'No hay campos para actualizar.');
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

    if (emailChanged || passwordChanged) {
      await refreshTokenSessionRepository.revokeAllForUser(targetId);
    }

    const responseBody: { admin: ReturnType<typeof toUserDto>; accessToken?: string; refreshToken?: string } = {
      admin: toUserDto(updatedUser),
    };

    if ((emailChanged || passwordChanged) && targetId === actorId) {
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

router.delete('/:id', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const targetId = req.params.id;
    const actorId = (req as AuthenticatedRequest).user!.userId;

    if (targetId === actorId) {
      throw new BusinessError('CANNOT_DELETE_SELF', 'No puedes eliminar tu propio usuario.');
    }

    const user = await userRepository.getById(targetId);
    if (!user) {
      throw new BusinessError('NOT_FOUND', 'Administrador no encontrado.');
    }

    const allAdmins = await userRepository.list();
    const adminCount = allAdmins.filter((u) => u.role === 'admin').length;
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
