import { Request, Response, NextFunction } from 'express';
import { normalizeDni } from '../../domain/business-rules';

interface DniEntry {
  timestamps: number[];
  blockedUntil: number;
  strike: number;
  lastViolationAt: number;
}

export interface ProgressiveDniLimiterOptions {
  /** Ventana móvil (ms) en la que se cuentan los intentos. */
  windowMs?: number;
  /** Intentos permitidos dentro de la ventana antes de bloquear. */
  maxAttempts?: number;
  /** Duración del primer bloqueo (ms); se duplica en cada reincidencia. */
  baseBlockMs?: number;
  /** Tope del bloqueo progresivo (ms). */
  maxBlockMs?: number;
  /** Máximo de claves retenidas en memoria antes de purgar expiradas. */
  maxKeys?: number;
}

export interface DniCheckResult {
  allowed: boolean;
  retryAfterMs: number;
  strike: number;
}

const DEFAULTS = {
  windowMs: 15 * 60 * 1000,
  maxAttempts: 5,
  baseBlockMs: 5 * 60 * 1000,
  maxBlockMs: 60 * 60 * 1000,
  maxKeys: 50_000,
};

/**
 * Limitador por cédula con bloqueo progresivo.
 *
 * Cada cédula acumula intentos dentro de una ventana móvil. Al superar el
 * máximo, se bloquea durante un tiempo que se duplica en cada reincidencia
 * (5m, 10m, 20m... hasta `maxBlockMs`). El nivel de bloqueo decae solo cuando
 * pasa una ventana completa sin nuevas infracciones.
 */
export class ProgressiveDniLimiter {
  private readonly windowMs: number;
  private readonly maxAttempts: number;
  private readonly baseBlockMs: number;
  private readonly maxBlockMs: number;
  private readonly maxKeys: number;
  private readonly entries = new Map<string, DniEntry>();

  constructor(options: ProgressiveDniLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
    this.maxAttempts = options.maxAttempts ?? DEFAULTS.maxAttempts;
    this.baseBlockMs = options.baseBlockMs ?? DEFAULTS.baseBlockMs;
    this.maxBlockMs = options.maxBlockMs ?? DEFAULTS.maxBlockMs;
    this.maxKeys = options.maxKeys ?? DEFAULTS.maxKeys;
  }

  check(key: string, now: number = Date.now()): DniCheckResult {
    if (this.entries.size > this.maxKeys) {
      this.prune(now);
    }

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { timestamps: [], blockedUntil: 0, strike: 0, lastViolationAt: 0 };
      this.entries.set(key, entry);
    }

    // El nivel de castigo decae tras una ventana completa sin infracciones.
    if (entry.strike > 0 && now - entry.lastViolationAt > this.windowMs) {
      entry.strike = 0;
    }

    if (entry.blockedUntil > now) {
      return { allowed: false, retryAfterMs: entry.blockedUntil - now, strike: entry.strike };
    }
    entry.blockedUntil = 0;

    entry.timestamps = entry.timestamps.filter((t) => now - t < this.windowMs);

    if (entry.timestamps.length >= this.maxAttempts) {
      entry.strike += 1;
      entry.lastViolationAt = now;
      const blockMs = Math.min(
        this.baseBlockMs * 2 ** (entry.strike - 1),
        this.maxBlockMs
      );
      entry.blockedUntil = now + blockMs;
      entry.timestamps = [];
      return { allowed: false, retryAfterMs: blockMs, strike: entry.strike };
    }

    entry.timestamps.push(now);
    return { allowed: true, retryAfterMs: 0, strike: entry.strike };
  }

  reset(key?: string): void {
    if (key === undefined) {
      this.entries.clear();
      return;
    }
    this.entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      const idle =
        entry.blockedUntil <= now &&
        entry.timestamps.length === 0 &&
        now - entry.lastViolationAt > this.windowMs;
      if (idle) this.entries.delete(key);
    }
  }
}

function publicDniKey(req: Request): string {
  const slug = String(req.params?.slug || '').trim().toLowerCase() || 'unknown';
  const dni = normalizeDni(String(req.body?.dni || ''));
  if (dni) return `${slug}:${dni}`;
  return `ip:${req.ip || 'unknown'}`;
}

export function createDniRateLimiter(limiter: ProgressiveDniLimiter) {
  return function dniRateLimit(req: Request, res: Response, next: NextFunction): void {
    const result = limiter.check(publicDniKey(req));
    if (result.allowed) {
      next();
      return;
    }
    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: {
        code: 'RATE_LIMITED',
        message: 'Demasiados intentos para esta cédula. Intenta de nuevo más tarde.',
      },
    });
  };
}

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  action?: string;
  hostname?: string;
}

export function isCaptchaEnabled(): boolean {
  return Boolean((process.env.TURNSTILE_SECRET_KEY || '').trim());
}

export interface CaptchaVerifierOptions {
  /** Acción esperada reportada por Turnstile (si se define, se valida). */
  action?: string;
}

/**
 * Verifica el token de Cloudflare Turnstile enviado en `body.turnstileToken`.
 *
 * Si `TURNSTILE_SECRET_KEY` no está configurada, la verificación se omite
 * (útil en desarrollo). En producción se recomienda configurarla junto con
 * `VITE_TURNSTILE_SITE_KEY` en el frontend.
 */
export function createCaptchaVerifier(options: CaptchaVerifierOptions = {}) {
  return async function verifyCaptcha(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const secret = (process.env.TURNSTILE_SECRET_KEY || '').trim();
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        console.warn(
          '[captcha] TURNSTILE_SECRET_KEY no configurada: el portal público se sirve sin CAPTCHA.'
        );
      }
      next();
      return;
    }

    const token = String(req.body?.turnstileToken || '').trim();
    if (!token) {
      res.status(403).json({
        error: {
          code: 'CAPTCHA_REQUIRED',
          message: 'Completa la verificación de seguridad e intenta de nuevo.',
        },
      });
      return;
    }

    try {
      const form = new URLSearchParams();
      form.append('secret', secret);
      form.append('response', token);
      if (req.ip) form.append('remoteip', req.ip);

      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      const data = (await response.json()) as TurnstileVerifyResponse;

      const actionMismatch =
        Boolean(options.action) &&
        Boolean(data.action) &&
        data.action !== options.action;

      if (!data.success || actionMismatch) {
        res.status(403).json({
          error: {
            code: 'CAPTCHA_FAILED',
            message: 'La verificación de seguridad falló. Recarga e intenta de nuevo.',
          },
        });
        return;
      }

      next();
    } catch (error) {
      console.error('[captcha] Error verificando Turnstile:', error);
      res.status(503).json({
        error: {
          code: 'CAPTCHA_UNAVAILABLE',
          message: 'No se pudo verificar la seguridad en este momento. Intenta de nuevo.',
        },
      });
    }
  };
}

export function createPublicDniLimiterFromEnv(): ProgressiveDniLimiter {
  const num = (value: string | undefined, fallback: number): number => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  return new ProgressiveDniLimiter({
    windowMs: num(process.env.PUBLIC_DNI_WINDOW_MS, DEFAULTS.windowMs),
    maxAttempts: num(process.env.PUBLIC_DNI_MAX_ATTEMPTS, DEFAULTS.maxAttempts),
    baseBlockMs: num(process.env.PUBLIC_DNI_BASE_BLOCK_MS, DEFAULTS.baseBlockMs),
    maxBlockMs: num(process.env.PUBLIC_DNI_MAX_BLOCK_MS, DEFAULTS.maxBlockMs),
  });
}
