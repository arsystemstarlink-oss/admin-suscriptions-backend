import { User } from '../domain/entities';
import { authService } from './auth-service';
import { refreshTokenSessionRepository } from '../infrastructure/repositories';

export async function createRefreshSession(
  user: User,
  token: string,
  jti: string,
  expiresAt: Date,
  rememberMe?: boolean,
) {
  const now = new Date();
  await refreshTokenSessionRepository.create({
    id: jti,
    userId: user.id,
    tokenHash: authService.hashToken(token),
    rememberMe,
    createdAt: now,
    expiresAt,
    lastUsedAt: now,
  });
}
