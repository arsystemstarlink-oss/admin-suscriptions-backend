import { Router, Request, Response, NextFunction } from 'express';
import {
  userRepository,
  adminInviteRepository,
  refreshTokenSessionRepository,
  organizationRepository,
} from '../../infrastructure/repositories';
import { authService } from '../../domain/auth-service';
import { BusinessError, AdminInvite, User, UserRole } from '../../domain/entities';
import { createId } from '../../domain/business-rules';
import { validateOrganizationAdminCount } from '../../domain/business-plan';
import { admin, syncUserCustomClaims } from '../../infrastructure/firebase';
import { authenticateAdmin, AuthenticatedRequest } from '../middleware/auth';
import { getAuth } from '../middleware/tenant';
import { isSuperAdmin } from '../../domain/auth-context';
import { requireWritablePlan } from '../middleware/organization-plan-access';
import { normalizePhoneToE164 } from '../../domain/phone';
import { EMAIL_REGEX, validatePasswordStrength } from '../../domain/validation';
import { createRefreshSession } from '../../domain/auth-session';
import { toAuthenticatedUserDto, toUserDto } from '../dto/user';

export { EMAIL_REGEX, validatePasswordStrength, toUserDto, toAuthenticatedUserDto };

const router = Router();

async function validateAndCreateUser(input: {
  name?: string;
  email?: string;
  password?: string;
  phone?: string;
  role?: UserRole;
  organizationId?: string | null;
}): Promise<User> {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
  const password = input.password || '';
  const role: UserRole = input.role === 'super-admin' ? 'super-admin' : 'admin';

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

  let organizationId: string | null = null;

  if (role === 'super-admin') {
    organizationId = null;
  } else {
    organizationId = input.organizationId ?? null;
    if (!organizationId) {
      throw new BusinessError(
        'TENANT_REQUIRED',
        'Un administrador debe pertenecer a una organización (organizationId).'
      );
    }
    const organization = await organizationRepository.getById(organizationId);
    if (!organization || !organization.active) {
      throw new BusinessError('ORGANIZATION_NOT_FOUND', 'La organización indicada no existe o está inactiva.');
    }
    const admins = await userRepository.listByOrganization(organizationId);
    validateOrganizationAdminCount(
      organization.plan ?? 'basico',
      admins.filter((adminUser) => adminUser.role === 'admin').length
    );
  }

  const user: User = {
    id: createId(),
    name,
    email,
    password: await authService.hashPassword(password),
    role,
    organizationId,
    phone: input.phone ? normalizePhoneToE164(input.phone) : undefined,
    mustChangePassword: role === 'admin',
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

  await syncUserCustomClaims({
    uid: user.id,
    role: user.role,
    organizationId: user.organizationId,
  });

  return user;
}

export { normalizePhoneToE164 };

async function resolveInvite(token: unknown): Promise<{
  invite: AdminInvite;
  user: User;
}> {
  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!rawToken) {
    throw new BusinessError('INVITE_NOT_FOUND', 'La invitación no existe.');
  }

  const invite = await adminInviteRepository.findByTokenHash(authService.hashToken(rawToken));
  if (!invite) {
    throw new BusinessError('INVITE_NOT_FOUND', 'La invitación no existe.');
  }
  if (invite.usedAt) {
    throw new BusinessError('INVITE_ALREADY_USED', 'Esta invitación ya fue utilizada.');
  }
  if (invite.expiresAt.getTime() <= Date.now()) {
    throw new BusinessError('INVITE_EXPIRED', 'Esta invitación expiró. Solicita una nueva.');
  }

  const user = await userRepository.getById(invite.userId);
  if (!user || user.email !== invite.email) {
    throw new BusinessError('INVITE_NOT_FOUND', 'La invitación no es válida.');
  }

  return { invite, user };
}

router.get('/invite/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { invite } = await resolveInvite(req.params.token);
    const organization = await organizationRepository.getById(invite.organizationId);
    if (!organization) {
      throw new BusinessError('INVITE_NOT_FOUND', 'La organización de la invitación no existe.');
    }

    res.json({
      invite: {
        email: invite.email,
        organizationName: organization.name,
        expiresAt: invite.expiresAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/invite/accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password, name } = req.body ?? {};
    if (typeof password !== 'string') {
      throw new BusinessError('INVALID_DATA', 'La contraseña es requerida.');
    }
    validatePasswordStrength(password);

    const { invite, user } = await resolveInvite(token);
    const trimmedName = typeof name === 'string' ? name.trim() : '';

    const consumed = await adminInviteRepository.consume(invite.id);
    if (!consumed) {
      throw new BusinessError('INVITE_ALREADY_USED', 'Esta invitación ya fue utilizada.');
    }

    try {
      const updatedUser: User = {
        ...user,
        ...(trimmedName ? { name: trimmedName } : {}),
        password: await authService.hashPassword(password),
        mustChangePassword: false,
      };
      await userRepository.update(updatedUser);

      try {
        await admin.auth().updateUser(user.id, {
          password,
          ...(trimmedName ? { displayName: trimmedName } : {}),
        });
      } catch (firebaseError: any) {
        console.warn(
          '[Auth] No se pudo actualizar el usuario de Firebase al aceptar la invitación:',
          firebaseError.message
        );
      }

      await refreshTokenSessionRepository.revokeAllForUser(user.id);

      const accessToken = authService.generateAccessToken(updatedUser);
      const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(updatedUser);
      await createRefreshSession(updatedUser, refreshToken, jti, expiresAt);

      res.json({
        message: 'Invitación aceptada. Tu contraseña quedó configurada.',
        accessToken,
        refreshToken,
        user: await toAuthenticatedUserDto(updatedUser),
      });
    } catch (err) {
      await adminInviteRepository.release(invite.id).catch(() => undefined);
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

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
    const rememberMe = req.body?.rememberMe !== false;
    const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(user, {
      rememberMe,
    });

    await createRefreshSession(user, refreshToken, jti, expiresAt, rememberMe);

    const updatedUser: User = { ...user, lastLoginAt: new Date() };
    await userRepository.update(updatedUser);

    await syncUserCustomClaims({
      uid: user.id,
      role: user.role,
      organizationId: user.organizationId,
    });

    res.json({
      accessToken,
      refreshToken,
      user: await toAuthenticatedUserDto(updatedUser),
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

    if (payload.role !== 'admin' && payload.role !== 'super-admin') {
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

    const rememberMe = session.rememberMe !== false;
    const { token: newRefreshToken, jti: newJti, expiresAt: newExpiresAt } =
      authService.generateRefreshToken(user, { rememberMe });

    await refreshTokenSessionRepository.update({
      ...session,
      revokedAt: new Date(),
      replacedBy: newJti,
      lastUsedAt: new Date(),
    });

    await createRefreshSession(user, newRefreshToken, newJti, newExpiresAt, rememberMe);

    await syncUserCustomClaims({
      uid: user.id,
      role: user.role,
      organizationId: user.organizationId,
    });

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

    const existingAdmins = await userRepository.countWhere([]);
    if (existingAdmins > 0) {
      throw new BusinessError('SETUP_DISABLED', 'Ya existe un administrador. Usa POST /auth/register.');
    }

    const user = await validateAndCreateUser({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      phone: req.body?.phone,
      role: 'super-admin',
      organizationId: null,
    });

    res.status(201).json({
      message: 'Super administrador creado correctamente.',
      user: toUserDto(user),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/register', authenticateAdmin, requireWritablePlan, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const actor = getAuth(req);
    const requestedRole: UserRole = req.body?.role === 'super-admin' ? 'super-admin' : 'admin';

    let role: UserRole;
    let organizationId: string | null;

    if (isSuperAdmin(actor)) {
      role = requestedRole;
      if (role === 'admin') {
        organizationId = (req.body?.organizationId as string) || null;
      } else {
        organizationId = null;
      }
    } else {
      role = 'admin';
      organizationId = actor.organizationId;
    }

    const user = await validateAndCreateUser({
      name: req.body?.name,
      email: req.body?.email,
      password: req.body?.password,
      phone: req.body?.phone,
      role,
      organizationId,
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
      user: await toAuthenticatedUserDto(user),
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

    res.json({ user: await toAuthenticatedUserDto(updatedUser) });
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
    const updatedUser: User = {
      ...user,
      password: hashedPassword,
      mustChangePassword: false,
    };
    await userRepository.update(updatedUser);

    try {
      await admin.auth().updateUser(user.id, { password: newPassword });
    } catch (firebaseError: any) {
      console.warn('[Auth] No se pudo actualizar la contraseña en Firebase Auth:', firebaseError.message);
    }

    await refreshTokenSessionRepository.revokeAllForUser(user.id);

    const accessToken = authService.generateAccessToken(updatedUser);
    const { token: refreshToken, jti, expiresAt } = authService.generateRefreshToken(updatedUser);
    await createRefreshSession(updatedUser, refreshToken, jti, expiresAt);

    res.json({
      message: 'Contraseña actualizada correctamente.',
      accessToken,
      refreshToken,
      user: await toAuthenticatedUserDto(updatedUser),
    });
  } catch (err) {
    next(err);
  }
});

export default router;
