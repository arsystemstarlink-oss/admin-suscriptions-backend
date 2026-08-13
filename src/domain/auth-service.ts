import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { User } from '../domain/entities';

const ACCESS_TOKEN_EXPIRES = '15m';
const REFRESH_TOKEN_EXPIRES_MS = 7 * 24 * 60 * 60 * 1000;
const SALT_ROUNDS = 10;
const MIN_JWT_SECRET_LENGTH = 32;

type TokenType = 'access' | 'refresh';

export interface TokenPayload {
  sub: string;
  userId: string;
  email: string;
  role: string;
  type: TokenType;
  jti?: string;
}

export interface GeneratedRefreshToken {
  token: string;
  jti: string;
  expiresAt: Date;
}

function resolveJwtSecret(): string {
  const secret = process.env.JWT_SECRET?.trim();

  if (!secret) {
    throw new Error('JWT_SECRET must be set in environment variables.');
  }

  if (secret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters.`);
  }

  if (
    process.env.NODE_ENV === 'production' &&
    secret.includes('change-this-in-production')
  ) {
    throw new Error('JWT_SECRET must be changed from the default value in production.');
  }

  return secret;
}

let cachedJwtSecret: string | null = null;

function getJwtSecret(): string {
  if (!cachedJwtSecret) {
    cachedJwtSecret = resolveJwtSecret();
  }
  return cachedJwtSecret;
}

export class AuthService {
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, SALT_ROUNDS);
  }

  async comparePassword(password: string, hashedPassword: string): Promise<boolean> {
    return bcrypt.compare(password, hashedPassword);
  }

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  generateAccessToken(user: User): string {
    const payload: TokenPayload = {
      sub: user.id,
      userId: user.id,
      email: user.email,
      role: user.role,
      type: 'access',
    };

    return jwt.sign(payload, getJwtSecret(), { expiresIn: ACCESS_TOKEN_EXPIRES });
  }

  generateRefreshToken(user: User): GeneratedRefreshToken {
    const jti = `rt_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRES_MS);

    const payload: TokenPayload = {
      sub: user.id,
      userId: user.id,
      email: user.email,
      role: user.role,
      type: 'refresh',
      jti,
    };

    const token = jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });

    return { token, jti, expiresAt };
  }

  verifyAccessToken(token: string): TokenPayload {
    return this.verifyToken(token, 'access');
  }

  verifyRefreshToken(token: string): TokenPayload {
    return this.verifyToken(token, 'refresh');
  }

  private verifyToken(token: string, expectedType: TokenType): TokenPayload {
    try {
      const decoded = jwt.verify(token, getJwtSecret()) as TokenPayload;

      if (decoded.type !== expectedType) {
        throw new Error('Token type mismatch');
      }

      return decoded;
    } catch {
      throw new Error(
        expectedType === 'access'
          ? 'Token inválido o expirado'
          : 'Refresh token inválido o expirado'
      );
    }
  }
}

export const authService = new AuthService();
