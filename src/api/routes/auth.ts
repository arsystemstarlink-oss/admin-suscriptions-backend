import { Router, Request, Response, NextFunction } from 'express';
import {
  userRepository,
  refreshTokenSessionRepository,
} from '../../infrastructure/repositories';
import { authService } from '../../domain/auth-service';
import { BusinessError, User } from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import { admin } from '../../infrastructure/firebase';
import { authenticateAdmin, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function toUserDto(user: User) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    phone: user.phone,
    role: user.role,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  };
}

export function validatePasswordStrength(password: string): void {
  if (password.length < 8) {
    throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe tener al menos 8 caracteres.');
  }
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) {
    throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe incluir letras y números.');
  }
}

async function validateAndCreateUser(input: {
  name?: string;
  email?: string;
  password?: string;
  phone?: string;
}): Promise<User> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input.password || '';

  if (!name) {
    throw new BusinessError('INVALID_DATA', 'El nombre es obligatorio.');
  }
  if (!email || !EMAIL_REGEX.test(email)) {
    throw new BusinessError('INVALID_EMAIL', 'El email no es válido.');
  }
  if (!password) {
    throw new BusinessError('INVALID_DATA', 'La contraseña es obligatoria.');
  }
  validatePasswordStrength(password);

  const existing = await userRepository.findByEmail(email);
  if (existing) {
    throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
  }

  const user: User = {
    id: createId(),
    name,
    email,
    password: await authService.hashPassword(password),
    role: 'admin',
    phone: input.phone ? normalizePhoneToE164(input.phone) : undefined,
    createdAt: new Date(),
  };

  await userRepository.create(user);

  try {
    await admin.auth().createUser({
      uid: user.id,
      email: user.email,
      password,
      displayName: user.name,
    });
  } catch (firebaseError: any) {
    if (firebaseError.code !== 'auth/email-already-exists') {
      console.warn('[Auth] No se pudo crear en Firebase Auth:', firebaseError.message);
    }
  }

  return user;
}

export function normalizePhoneToE164(value: string): string {
  const digits = value.replace(/\D/g, '');
  let national = digits;

  if (national.startsWith('58') && national.length > 11) {
    national = national.slice(2);
  } else if (national.startsWith('0')) {
    national = national.slice(1);
  }

  national = national.slice(0, 11);

  if (national.length < 10) {
    throw new BusinessError('INVALID_PHONE', 'Número de teléfono inválido.');
  }

  return `+58${national}`;
}

async function createRefreshSession(user: User, token: string, jti: string, expiresAt: Date) {
  const now = new Date();
  await refreshTokenSessionRepository.create({
    id: jti,
    userId: user.id,
    tokenHash: authService.hashToken(token),
    createdAt: now,
    expiresAt,
    lastUsedAt: now,
  });
}

router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      throw new BusinessError('INVALID_DATA', 'Email y contraseña son requeridos.');
    }

    const normalizedEmail = String(email).trim().toLowerCase();

    const user = await userRepository.findByEmail(normalizedEmail);

    if (!user) {
      throw new BusinessError('INVALID_CREDENTIALS', 'Credenciales inválidas.');
    }

    const isValidPassword = await authService.comparePassword(password, user.password);
    if (!isValidPassword) {
      throw new BusinessError('INVALID_CREDENTIALS', 'Credenciales inválidas.');
    }

    const accessToken = authService.generateAccessToken(user);
    const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(user);

    await createRefreshSession(user, refreshToken, jti, expiresAt);

    const updatedUser: User = { ...user, lastLoginAt: new Date() };
    await userRepository.update(updatedUser);

    res.json({
      accessToken,
      refreshToken,
      user: toUserDto(updatedUser),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw new BusinessError('INVALID_DATA', 'Refresh token es requerido.');
    }

    let payload;
    try {
      payload = authService.verifyRefreshToken(refreshToken);
    } catch {
      throw new BusinessError('UNAUTHORIZED', 'Refresh token inválido o expirado.');
    }

    if (payload.role !== 'admin') {
      throw new BusinessError('FORBIDDEN', 'Se requieren permisos de administrador.');
    }

    const session = payload.jti
      ? await refreshTokenSessionRepository.getById(payload.jti)
      : undefined;

    if (!session || session.revokedAt) {
      await refreshTokenSessionRepository.revokeAllForUser(payload.userId);
      throw new BusinessError('REFRESH_TOKEN_REVOKED', 'Sesión revocada. Inicia sesión nuevamente.');
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      throw new BusinessError('UNAUTHORIZED', 'Refresh token expirado.');
    }

    const user = await userRepository.getById(payload.userId);
    if (!user) {
      throw new BusinessError('USER_NOT_FOUND', 'Usuario no encontrado.');
    }

    const { token: newRefreshToken, jti: newJti, expiresAt: newExpiresAt } =
      authService.generateRefreshToken(user);

    await refreshTokenSessionRepository.update({
      ...session,
      revokedAt: new Date(),
      replacedBy: newJti,
      lastUsedAt: new Date(),
    });

    await createRefreshSession(user, newRefreshToken, newJti, newExpiresAt);

    res.json({
      accessToken: authService.generateAccessToken(user),
      refreshToken: newRefreshToken,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      res.status(204).send();
      return;
    }

    try {
      const payload = authService.verifyRefreshToken(refreshToken);
      if (payload.jti) {
        const session = await refreshTokenSessionRepository.getById(payload.jti);
        if (session && !session.revokedAt) {
          await refreshTokenSessionRepository.update({
            ...session,
            revokedAt: new Date(),
          });
        }
      }
    } catch {
      // Token ya inválido; no hay nada que revocar. Idempotente.
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

router.post('/setup', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const setupKey = req.headers['x-setup-key'];
    const expectedKey = process.env.SETUP_KEY?.trim();

    if (!expectedKey) {
      throw new BusinessError('SETUP_DISABLED', 'La creación de administrador no está habilitada.');
    }

    if (!setupKey || setupKey !== expectedKey) {
      throw new BusinessError('INVALID_SETUP_KEY', 'Clave de setup inválida.');
    }

    const existingAdmins = await userRepository.list();
    if (existingAdmins.length > 0) {
      throw new BusinessError('SETUP_DISABLED', 'Ya existe un administrador. Usa POST /auth/register.');
    }

    const user = await validateAndCreateUser({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      phone: req.body?.phone,
    });

    res.status(201).json({
      message: 'Administrador creado correctamente.',
      user: toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/register', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const user = await validateAndCreateUser({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      phone: req.body?.phone,
    });

    res.status(201).json({
      message: 'Administrador creado correctamente.',
      user: toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/me', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as AuthenticatedRequest).user!.userId;

    const user = await userRepository.getById(userId);
    if (!user) {
      throw new BusinessError('USER_NOT_FOUND', 'Usuario no encontrado.');
    }

    res.json({
      user: toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

router.put('/me', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as AuthenticatedRequest).user!.userId;
    const { name, email, phone, currentPassword } = req.body;

    const user = await userRepository.getById(userId);
    if (!user) {
      throw new BusinessError('USER_NOT_FOUND', 'Usuario no encontrado.');
    }

    const updates: Partial<User> = {};
    let emailChanged = false;

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
        emailChanged = true;
        const existing = await userRepository.findByEmail(normalizedEmail);
        if (existing && existing.id !== user.id) {
          throw new BusinessError('EMAIL_TAKEN', 'Ya existe un usuario con ese email.');
        }
        updates.email = normalizedEmail;
      }
    }

    if (phone !== undefined) {
      updates.phone = phone ? normalizePhoneToE164(phone) : undefined;
    }

    if (emailChanged) {
      if (!currentPassword) {
        throw new BusinessError(
          'INVALID_PASSWORD',
          'Ingresa tu contraseña actual para cambiar el email.'
        );
      }
      const isValidPassword = await authService.comparePassword(currentPassword, user.password);
      if (!isValidPassword) {
        throw new BusinessError('INVALID_PASSWORD', 'La contraseña actual es incorrecta.');
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new BusinessError('INVALID_DATA', 'No hay campos para actualizar.');
    }

    const updatedUser: User = { ...user, ...updates };
    await userRepository.update(updatedUser);

    res.json({ user: toUserDto(updatedUser) });
  } catch (err) {
    next(err);
  }
});

router.post('/change-password', authenticateAdmin, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = (req as AuthenticatedRequest).user!.userId;
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword) {
      throw new BusinessError('INVALID_DATA', 'La contraseña actual es requerida.');
    }
    if (!newPassword) {
      throw new BusinessError('INVALID_DATA', 'La nueva contraseña es requerida.');
    }

    const user = await userRepository.getById(userId);
    if (!user) {
      throw new BusinessError('USER_NOT_FOUND', 'Usuario no encontrado.');
    }

    const isValidPassword = await authService.comparePassword(currentPassword, user.password);
    if (!isValidPassword) {
      throw new BusinessError('INVALID_PASSWORD', 'La contraseña actual es incorrecta.');
    }

    if (newPassword.length < 8) {
      throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe tener al menos 8 caracteres.');
    }
    if (!/[a-zA-Z]/.test(newPassword) || !/\d/.test(newPassword)) {
      throw new BusinessError('WEAK_PASSWORD', 'La contraseña debe incluir letras y números.');
    }

    const hashedPassword = await authService.hashPassword(newPassword);
    const updatedUser: User = { ...user, password: hashedPassword };
    await userRepository.update(updatedUser);

    await refreshTokenSessionRepository.revokeAllForUser(user.id);

    const accessToken = authService.generateAccessToken(updatedUser);
    const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(updatedUser);
    await createRefreshSession(updatedUser, refreshToken, jti, expiresAt);

    res.json({
      message: 'Contraseña actualizada correctamente.',
      accessToken,
      refreshToken,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
